/**
 * emotion.js —— 本地人脸情绪识别引擎
 * ==================================================================
 * 一、模型（全部离线，模型文件在 /models 目录，约 600KB）
 *   1) TinyFaceDetector      —— 基于 MobileNetV1 + SSD 的轻量人脸检测器
 *                               输入 416×416，输出人脸框 + 置信度
 *   2) FaceLandmark68TinyNet —— 68 点关键点回归，用于人脸对齐与可视化
 *   3) FaceExpressionNet     —— 64×64 灰度人脸 → 7 类表情 softmax
 *                               neutral / happy / sad / angry / fearful / disgusted / surprised
 *
 * 二、识别流程
 *   视频帧/图片 → 检测人脸框 → 裁剪+对齐到 64×64 → CNN 前向 → 7 维概率
 *
 * 三、本模块在原始输出之上做的三层增强
 *   (1) 质量门控：检测分数 < 0.42 或人脸面积过小 → 丢弃该帧，避免噪声污染
 *   (2) 时间平滑：指数加权移动平均（EWMA）
 *         w_k = score_k · exp(-(now - t_k)/τ),  τ = 900ms, 窗口 2000ms
 *         p_smooth(i) = Σ w_k·p_k(i) / Σ w_k
 *       作用：抑制单帧抖动，让推荐结果稳定而不是每帧乱跳
 *   (3) 连续情感映射（Russell 环形模型）
 *         V = Σ p_smooth(i)·V_i ,  A = Σ p_smooth(i)·A_i
 *       7 类离散表情 → (valence 效价, arousal 唤醒) 二维连续空间，
 *       推荐算法在这一连续空间中计算距离，比"离散情绪查表"平滑得多
 * ==================================================================
 */
(function (global) {
  'use strict';

  const MODEL_URL = 'models/';
  const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
  const WINDOW_MS = 2000;   // 平滑窗口
  const TAU_MS = 900;       // EWMA 时间常数
  const MIN_SCORE = 0.42;   // 检测分数门限
  const MIN_AREA = 0.012;   // 人脸面积占画面比例下限

  const eventBus = new EventTarget();

  class EmotionEngine {
    constructor() {
      this.ready = false;
      this.frames = [];        // 平滑窗口内的历史帧
      this.lastRaw = null;
      this.detectOptions = null;
    }

    /** 加载三个模型（离线） */
    async load(onStep) {
      if (this.ready) return true;
      const faceapi = global.faceapi;
      if (!faceapi) throw new Error('face-api.js 未能加载，请确认 lib/face-api.js 存在');

      const step = (n, txt) => onStep && onStep(n, txt);
      step(10, '初始化 TensorFlow 后端…');
      try { await faceapi.tf.setBackend('webgl'); } catch (e) { /* 回退 cpu */ }
      await faceapi.tf.ready();

      step(30, '加载人脸检测模型 tiny_face_detector…');
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);

      step(60, '加载 68 点关键点模型…');
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);

      step(85, '加载表情分类模型 face_expression…');
      await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);

      this.detectOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: MIN_SCORE
      });

      step(100, '模型就绪');
      this.ready = true;
      return true;
    }

    /** 对任意图像输入（canvas / video / img）做一次检测 */
    async detect(input) {
      if (!this.ready) return null;
      const faceapi = global.faceapi;
      const res = await faceapi
        .detectSingleFace(input, this.detectOptions)
        .withFaceLandmarks(true)
        .withFaceExpressions();

      if (!res) { this.lastRaw = null; return null; }

      const box = res.detection.box;
      const iw = input.videoWidth || input.naturalWidth || input.width || 1;
      const ih = input.videoHeight || input.naturalHeight || input.height || 1;
      const areaRatio = (box.width * box.height) / (iw * ih);

      const frame = {
        expressions: res.expressions,
        score: res.detection.score,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        landmarks: res.landmarks ? res.landmarks.positions.map(p => ({ x: p.x, y: p.y })) : null,
        areaRatio: areaRatio,
        quality: this._quality(res.detection.score, areaRatio),
        ts: performance.now()
      };
      this.lastRaw = frame;
      return frame;
    }

    /** 人脸质量 0~1：综合检测置信度与画面占比 */
    _quality(score, areaRatio) {
      const s = Math.min(1, Math.max(0, (score - 0.3) / 0.6));
      const a = Math.min(1, areaRatio / 0.18);
      return 0.55 * s + 0.45 * a;
    }

    /** 把一帧推进平滑窗口 */
    push(frame) {
      if (!frame) return;
      if (frame.areaRatio < MIN_AREA) return;   // 人脸太小，识别不可靠，丢弃
      this.frames.push(frame);
      const now = performance.now();
      this.frames = this.frames.filter(f => now - f.ts < WINDOW_MS);
      if (this.frames.length > 60) this.frames.shift();
      eventBus.dispatchEvent(new CustomEvent('frame', { detail: frame }));
    }

    reset() { this.frames = []; this.lastRaw = null; }

    /**
     * 计算加权平滑后的情绪向量
     * @returns {null|{probs, valence, arousal, dominant, confidence, stability, frames}}
     */
    smooth(now) {
      now = now || performance.now();
      const live = this.frames.filter(f => now - f.ts < WINDOW_MS);
      if (!live.length) return null;

      const acc = {};
      EMOTIONS.forEach(k => (acc[k] = 0));
      let total = 0;
      live.forEach(f => {
        const w = Math.max(0.001, f.score) * Math.exp(-(now - f.ts) / TAU_MS);
        total += w;
        EMOTIONS.forEach(k => (acc[k] += (f.expressions[k] || 0) * w));
      });
      if (total <= 0) return null;

      const probs = {};
      EMOTIONS.forEach(k => (probs[k] = acc[k] / total));

      // 主导情绪 + 置信度（top1 与 top2 的间隔越大越可信）
      const sorted = EMOTIONS.slice().sort((a, b) => probs[b] - probs[a]);
      const top1 = sorted[0], top2 = sorted[1];
      const margin = probs[top1] - probs[top2];
      const avgQuality = live.reduce((s, f) => s + f.quality, 0) / live.length;
      const confidence = Math.max(0, Math.min(1,
        0.35 * Math.min(1, live.length / 3) + 0.4 * probs[top1] + 0.25 * margin
      )) * (0.6 + 0.4 * avgQuality);

      // 情绪稳定度：窗口内主导情绪一致帧的占比
      const stable = live.filter(f => this._argmax(f.expressions) === top1).length / live.length;

      const space = global.MoodTune.EMOTION_SPACE;
      let v = 0, a = 0;
      EMOTIONS.forEach(k => {
        v += probs[k] * space[k].v;
        a += probs[k] * space[k].a;
      });

      return {
        probs: probs,
        sorted: sorted,
        valence: v,
        arousal: a,
        dominant: top1,
        dominantCn: space[top1].cn,
        confidence: confidence,
        stability: stable,
        frames: live.length,
        quality: avgQuality
      };
    }

    _argmax(obj) {
      let best = 'neutral', bv = -1;
      EMOTIONS.forEach(k => { if ((obj[k] || 0) > bv) { bv = obj[k] || 0; best = k; } });
      return best;
    }

    /** 主动学习：把用户确认/修正的情绪注入窗口（用于演示模式或纠错） */
    inject(probs, weight) {
      const p = {};
      EMOTIONS.forEach(k => (p[k] = probs[k] || 0));
      const frame = {
        expressions: p, score: weight || 0.95,
        box: { x: 0, y: 0, width: 1, height: 1 },
        landmarks: null, areaRatio: 0.2, quality: 0.9,
        ts: performance.now(), synthetic: true
      };
      // 若窗口里是真实帧则清空，避免两种来源打架；注入帧之间则累积，使置信度稳定
      if (!this.frames.length || !this.frames[0].synthetic) this.frames = [];
      this.frames.push(frame);
      const now = performance.now();
      this.frames = this.frames.filter(f => now - f.ts < WINDOW_MS);
    }
  }

  global.MoodTune = global.MoodTune || {};
  global.MoodTune.EMOTIONS = EMOTIONS;
  global.MoodTune.EmotionEngine = EmotionEngine;
  global.MoodTune.emotionBus = eventBus;
})(window);
