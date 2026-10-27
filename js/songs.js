/**
 * songs.js —— 本地曲库 + 音乐特征定义
 * ------------------------------------------------------------------
 * 每首歌都带一组合成的「音乐画像」特征，供推荐算法计算：
 *   valence  效价 0~1  ：音乐情感的正负向（越小越忧郁/压抑）
 *   arousal  唤醒 0~1  ：音乐的激烈程度（越大越紧张/兴奋）
 *   energy   能量 0~1  ：配器密度与响度（与 arousal 相关但不等价）
 *   tempo    BPM
 *   tags     语义标签，用于标签共现匹配
 * 这些值不是随机填的，而是按合成时的 BPM / 调式 / 音色 / 节奏型标注，
 * 因此算法给出的「开心歌」听起来确实是开心的。
 */
(function (global) {
  'use strict';

  // ---- 情绪原型：7 类离散表情 → 二维连续情感空间（Russell 环形模型）----
  const EMOTION_SPACE = {
    happy:     { v: 0.86, a: 0.70, cn: '开心', en: 'Happy',     color: '#f9a8d4' },
    sad:       { v: 0.16, a: 0.26, cn: '悲伤', en: 'Sad',       color: '#60a5fa' },
    angry:     { v: 0.22, a: 0.88, cn: '愤怒', en: 'Angry',     color: '#f87171' },
    fearful:   { v: 0.28, a: 0.64, cn: '恐惧', en: 'Fearful',   color: '#a78bfa' },
    disgusted: { v: 0.24, a: 0.46, cn: '厌恶', en: 'Disgusted', color: '#94a3b8' },
    surprised: { v: 0.62, a: 0.84, cn: '惊讶', en: 'Surprised', color: '#fbbf24' },
    neutral:   { v: 0.50, a: 0.44, cn: '平静', en: 'Neutral',   color: '#7dd3fc' }
  };

  // 情绪 → 语义标签映射（用于标签匹配项）
  const EMOTION_TAGS = {
    happy:     ['happy', 'bright', 'pop', 'uplifting', 'sunny', 'summer', 'dance'],
    sad:       ['sad', 'lonely', 'rainy', 'night', 'mellow', 'solitude', 'acoustic'],
    angry:     ['angry', 'intense', 'rock', 'power', 'release', 'heavy', 'tense'],
    fearful:   ['fearful', 'eerie', 'dark', 'suspense', 'ambient', 'tense'],
    disgusted: ['minimal', 'empty', 'dark', 'chill', 'lofi'],
    surprised: ['surprised', 'burst', 'edm', 'exciting', 'bright', 'hope'],
    neutral:   ['neutral', 'calm', 'lofi', 'focus', 'study', 'soft', 'minimal']
  };

  // 疗愈目标：把负向情绪往「温和正向」牵引时所期望的标签
  const HEAL_TAGS = {
    sad:       ['heal', 'hope', 'warm', 'gentle', 'piano', 'acoustic', 'bright'],
    angry:     ['calm', 'soft', 'ambient', 'gentle', 'float', 'dreamy'],
    fearful:   ['calm', 'warm', 'soft', 'hope', 'gentle', 'piano'],
    disgusted: ['fresh', 'warm', 'bright', 'hope', 'acoustic'],
    happy:     ['happy', 'bright', 'uplifting', 'sunny'],
    surprised: ['calm', 'warm', 'dreamy', 'soft'],
    neutral:   ['calm', 'focus', 'dreamy', 'soft']
  };

  // ---- 本地曲库（音频文件位于 /music，全部为本机离线可播放）----
  const LOCAL_SONGS = [
    {
      id: 'L01', title: '阳光方程式', artist: 'MoodTune Lab', file: 'music/sunny-equation.wav',
      duration: 27.8, valence: 0.86, arousal: 0.68, energy: 0.70, tempo: 116, mode: 'major',
      tags: ['happy', 'bright', 'pop', 'uplifting', 'sunny'],
      emoji: '☀️', cover: 'linear-gradient(135deg,#fde68a,#fb923c)',
      note: 'C 大调明亮进行，八分音符琶音，典型"晴天感"流行编配。'
    },
    {
      id: 'L02', title: '夏日橙汽水', artist: 'MoodTune Lab', file: 'music/summer-soda.wav',
      duration: 25.5, valence: 0.90, arousal: 0.80, energy: 0.82, tempo: 128, mode: 'major',
      tags: ['happy', 'energetic', 'pop', 'summer', 'dance', 'bright'],
      emoji: '🍊', cover: 'linear-gradient(135deg,#fdba74,#f43f5e)',
      note: '128BPM 切分鼓点 + 三角波琶音，舞曲化的快乐。'
    },
    {
      id: 'L03', title: '雨落无声', artist: 'MoodTune Lab', file: 'music/rain-silence.wav',
      duration: 26.2, valence: 0.14, arousal: 0.22, energy: 0.18, tempo: 62, mode: 'minor',
      tags: ['sad', 'calm', 'piano', 'rainy', 'solitude', 'soft'],
      emoji: '🌧️', cover: 'linear-gradient(135deg,#64748b,#1e40af)',
      note: 'a 小调、62BPM、无鼓、长混响，把"低落"铺满整个空间。'
    },
    {
      id: 'L04', title: '深夜站台', artist: 'MoodTune Lab', file: 'music/midnight-platform.wav',
      duration: 29.7, valence: 0.22, arousal: 0.34, energy: 0.30, tempo: 72, mode: 'minor',
      tags: ['sad', 'night', 'mellow', 'lonely', 'acoustic'],
      emoji: '🌙', cover: 'linear-gradient(135deg,#334155,#0f172a)',
      note: 'e 小调慢板，稀疏底鼓模拟列车节律，孤独但不刺激。'
    },
    {
      id: 'L05', title: '怒潮', artist: 'MoodTune Lab', file: 'music/rage-tide.wav',
      duration: 28.9, valence: 0.20, arousal: 0.92, energy: 0.95, tempo: 148, mode: 'minor',
      tags: ['angry', 'intense', 'rock', 'power', 'release', 'heavy'],
      emoji: '🔥', cover: 'linear-gradient(135deg,#ef4444,#7f1d1d)',
      note: 'f# 小调锯齿波强力和弦 + 四踩底鼓，用来"释放"而不是"激化"。'
    },
    {
      id: 'L06', title: '铁幕', artist: 'MoodTune Lab', file: 'music/iron-curtain.wav',
      duration: 27.3, valence: 0.16, arousal: 0.96, energy: 0.97, tempo: 158, mode: 'minor',
      tags: ['angry', 'dark', 'industrial', 'heavy', 'tense', 'intense'],
      emoji: '⚙️', cover: 'linear-gradient(135deg,#525252,#171717)',
      note: '半音阶主导的工业质感，158BPM，压迫感最强的一首。'
    },
    {
      id: 'L07', title: '微光自习室', artist: 'MoodTune Lab', file: 'music/study-glow.wav',
      duration: 23.6, valence: 0.55, arousal: 0.30, energy: 0.25, tempo: 70, mode: 'major',
      tags: ['calm', 'focus', 'lofi', 'study', 'soft', 'neutral'],
      emoji: '💡', cover: 'linear-gradient(135deg,#a5b4fc,#c7d2fe)',
      note: '大七和弦无鼓铺底，专注向 lo-fi 氛围。'
    },
    {
      id: 'L08', title: '云端漫步', artist: 'MoodTune Lab', file: 'music/cloud-walk.wav',
      duration: 26.4, valence: 0.66, arousal: 0.38, energy: 0.36, tempo: 82, mode: 'major',
      tags: ['calm', 'dreamy', 'ambient', 'float', 'soft'],
      emoji: '☁️', cover: 'linear-gradient(135deg,#bae6fd,#818cf8)',
      note: 'G 大调七和弦漂浮感，极轻的踩镲维持推进。'
    },
    {
      id: 'L09', title: '迷雾回声', artist: 'MoodTune Lab', file: 'music/mist-echo.wav',
      duration: 24.8, valence: 0.24, arousal: 0.58, energy: 0.45, tempo: 88, mode: 'minor',
      tags: ['fearful', 'eerie', 'dark', 'suspense', 'ambient'],
      emoji: '🌫️', cover: 'linear-gradient(135deg,#4c1d95,#1e1b4b)',
      note: '减三/增三和弦交替制造不稳定感，大混响空场。'
    },
    {
      id: 'L10', title: '空白房间', artist: 'MoodTune Lab', file: 'music/blank-room.wav',
      duration: 25.3, valence: 0.46, arousal: 0.42, energy: 0.40, tempo: 86, mode: 'minor',
      tags: ['neutral', 'minimal', 'lofi', 'empty', 'chill'],
      emoji: '🪟', cover: 'linear-gradient(135deg,#94a3b8,#475569)',
      note: 'd 小调极简循环，情绪中性、不打扰。'
    },
    {
      id: 'L11', title: '烟花爆破', artist: 'MoodTune Lab', file: 'music/firework-burst.wav',
      duration: 28.5, valence: 0.70, arousal: 0.86, energy: 0.88, tempo: 132, mode: 'major',
      tags: ['surprised', 'burst', 'edm', 'exciting', 'bright'],
      emoji: '🎆', cover: 'linear-gradient(135deg,#fbbf24,#ec4899)',
      note: '每两小节一次强切分 + 铃音爆发，制造"惊喜"。'
    },
    {
      id: 'L12', title: '星光跃迁', artist: 'MoodTune Lab', file: 'music/starlight-leap.wav',
      duration: 26.2, valence: 0.76, arousal: 0.80, energy: 0.82, tempo: 124, mode: 'major',
      tags: ['surprised', 'uplifting', 'synth', 'bright', 'hope'],
      emoji: '✨', cover: 'linear-gradient(135deg,#67e8f9,#6366f1)',
      note: 'B 大调上行旋律 + 铃音琶音，惊讶但正向。'
    },
    {
      id: 'L13', title: '疗愈晨光', artist: 'MoodTune Lab', file: 'music/healing-dawn.wav',
      duration: 25.1, valence: 0.70, arousal: 0.32, energy: 0.28, tempo: 76, mode: 'major',
      tags: ['heal', 'hope', 'warm', 'piano', 'gentle', 'calm'],
      emoji: '🌅', cover: 'linear-gradient(135deg,#fcd34d,#fda4af)',
      note: '降 E 大调、76BPM，专为"情绪疗愈"策略设计的目标曲。'
    },
    {
      id: 'L14', title: '雨后初晴', artist: 'MoodTune Lab', file: 'music/after-rain.wav',
      duration: 27.0, valence: 0.74, arousal: 0.48, energy: 0.46, tempo: 90, mode: 'major',
      tags: ['heal', 'hope', 'fresh', 'acoustic', 'bright'],
      emoji: '🌈', cover: 'linear-gradient(135deg,#7dd3fc,#a7f3d0)',
      note: 'F 大调轻快走向，从阴雨转到放晴的过渡感。'
    }
  ].map(function (s, i) {
    s.source = 'local';
    s.order = i;
    s.src = s.file;
    return s;
  });

  global.MoodTune = global.MoodTune || {};
  global.MoodTune.EMOTION_SPACE = EMOTION_SPACE;
  global.MoodTune.EMOTION_TAGS = EMOTION_TAGS;
  global.MoodTune.HEAL_TAGS = HEAL_TAGS;
  global.MoodTune.LOCAL_SONGS = LOCAL_SONGS;
})(window);
