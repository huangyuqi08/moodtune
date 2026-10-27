/**
 * app.js —— MoodTune 主应用（Vue 3 Composition API）
 * 负责：四路取像 → 检测循环 → 情绪平滑 → 推荐调度 → 播放器
 */
(function () {
  'use strict';
  const { createApp, ref, computed, shallowRef, onMounted, onBeforeUnmount, watch } = Vue;

  const MT = window.MoodTune;
  const EMOTION_KEYS = MT.EMOTIONS;
  const SPACE = MT.EMOTION_SPACE;

  const EMO_EMOJI = {
    happy: '😄', sad: '😢', angry: '😠', fearful: '😨',
    disgusted: '😖', surprised: '😲', neutral: '😐'
  };

  const EMO_DESC = {
    happy: '眉眼舒展、嘴角上扬，颧大肌与眼轮匝肌协同激活，是置信度最高的一类表情。',
    sad: '眉头上扬内聚、嘴角下垂，眼周肌肉松弛，常伴随视线下移。',
    angry: '眉头紧锁下压、下颌咬紧，眼睑用力，面部整体向前收紧。',
    fearful: '眉毛上挑并内聚，眼睛睁大暴露眼白，嘴唇横向拉伸。',
    disgusted: '鼻梁皱起、上唇上提，眉间出现纵向纹路。',
    surprised: '眉毛高高抬起、嘴巴张开，面部纵向整体拉伸，持续时间通常很短。',
    neutral: '面部肌肉张力均衡，无明显表情特征，此时效价与唤醒度都接近中值。'
  };

  // 在线检索用的情绪关键词
  const ONLINE_QUERY = {
    happy: 'happy upbeat pop', sad: 'sad acoustic ballad',
    angry: 'angry rock metal', fearful: 'dark ambient suspense',
    disgusted: 'minimal chill lofi', surprised: 'energetic edm dance',
    neutral: 'calm piano instrumental'
  };

  const W_LABEL = { simVA: 'V-A', tag: '标签', energy: '能量', tempo: '速度', mode: '调性', profile: '画像' };

  // 68 点标准分组：[起始索引, 结束索引, 是否闭合]
  const LM_GROUPS = [
    [0, 16, false],   // 下颌轮廓
    [17, 21, false],  // 右眉
    [22, 26, false],  // 左眉
    [27, 30, false],  // 鼻梁
    [31, 35, false],  // 鼻底
    [36, 41, true],   // 右眼
    [42, 47, true],   // 左眼
    [48, 59, true],   // 外唇
    [60, 67, true]    // 内唇
  ];

  createApp({
    setup() {
      /* ---------------- 基础状态 ---------------- */
      const modelReady = ref(false);
      const modelError = ref(false);
      const loadPct = ref(0);
      const detecting = ref(false);
      const fps = ref(0);

      const mode = ref('image');
      const hasFrame = ref(false);
      const srcW = ref(0);
      const srcH = ref(0);
      const lastScore = ref(0);
      const faceArea = ref(0);
      const faceFound = ref(false);
      const mirrored = ref(false);
      const protocolWarning = ref(location.protocol === 'file:');

      const emotion = ref(null);
      const probs = ref(EMOTION_KEYS.reduce(function (o, k) { o[k] = 0; return o; }, {}));
      const simEmotion = ref('');

      const stage = ref(null);
      const imgInput = ref(null);
      const vidInput = ref(null);
      const audio = ref(null);

      const localSongs = ref(MT.LOCAL_SONGS.slice());
      const onlineSongs = ref([]);
      const allSongs = computed(() => localSongs.value.concat(onlineSongs.value));

      const strategy = ref('heal');
      const strategies = MT.STRATEGIES;
      const recResult = ref(null);
      const recItems = ref([]);
      const poolMode = ref('local');
      const onlineLoading = ref(false);

      const current = ref(null);
      const playing = ref(false);
      const curTime = ref(0);
      const duration = ref(0);
      const volume = ref(0.8);
      const likedIds = ref([]);
      const profile = ref({ v: 0.5, a: 0.5, n: 0 });

      const toasts = ref([]);
      const showAlgo = ref(false);
      const showHelp = ref(false);

      /* ---------------- 引擎与运行时对象 ---------------- */
      const engine = new MT.EmotionEngine();
      const recommender = new MT.Recommender();

      let videoEl = null;
      let imgEl = null;
      let ctx = null;
      let rafId = null;
      let cameraStream = null;
      let lastFrame = null;
      let detectingBusy = false;
      let lastDetectAt = 0;
      let lastRecAt = 0;
      let lastRecV = -9, lastRecA = -9;
      let fpsCounter = 0, fpsStart = 0;
      let simTimer = null;
      let wantSample = false;    // ?sample=1 时模型就绪后自动载入示例照片
      const toastSeq = ref(0);

      /* ---------------- 工具 ---------------- */
      function toast(msg, type) {
        const id = ++toastSeq.value;
        toasts.value.push({ id: id, msg: msg, type: type || '' });
        setTimeout(() => {
          toasts.value = toasts.value.filter(t => t.id !== id);
        }, 4200);
      }

      function fmt(sec) {
        sec = Math.max(0, sec || 0);
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
      }

      /* ---------------- 模型加载 ---------------- */
      async function initModels() {
        if (protocolWarning.value) {
          modelError.value = true;
          toast('检测到 file:// 协议，模型无法加载。请用 start.bat 或 http 服务打开。', 'err');
          return;
        }
        try {
          await engine.load(function (pct, txt) {
            loadPct.value = pct;
          });
          modelReady.value = true;
          toast('情绪识别模型加载完成（3 个模型，约 600KB）', 'ok');
          if (wantSample) setTimeout(loadSample, 200);
        } catch (e) {
          console.error(e);
          modelError.value = true;
          toast('模型加载失败：' + (e.message || e), 'err');
        }
      }

      /* ---------------- 舞台绘制 ---------------- */
      function setupStage(w, h) {
        const c = stage.value;
        if (!c || !w || !h) return;
        c.width = w;
        c.height = h;
        ctx = c.getContext('2d');
        srcW.value = w;
        srcH.value = h;
        hasFrame.value = true;
      }

      function drawFrame() {
        if (!ctx) return;
        const w = stage.value.width, h = stage.value.height;
        ctx.clearRect(0, 0, w, h);

        if (mode.value === 'camera' || mode.value === 'video') {
          if (videoEl && videoEl.readyState >= 2) {
            if (mirrored.value) {
              ctx.save();
              ctx.translate(w, 0);
              ctx.scale(-1, 1);
              ctx.drawImage(videoEl, 0, 0, w, h);
              ctx.restore();
            } else {
              ctx.drawImage(videoEl, 0, 0, w, h);
            }
          }
        } else if (imgEl) {
          ctx.drawImage(imgEl, 0, 0, w, h);
        }

        drawOverlay(w, h);
      }

      function drawOverlay(w, h) {
        if (!lastFrame) return;
        const k = Math.max(1, w / 800);          // 大图上放大线宽与字号
        const b = lastFrame.box;
        const x = mirrored.value ? (w - b.x - b.width) : b.x;
        const y = b.y;

        // 人脸框四角
        ctx.save();
        ctx.strokeStyle = 'rgba(34,211,238,0.95)';
        ctx.lineWidth = 2.5 * k;
        ctx.shadowColor = 'rgba(34,211,238,0.85)';
        ctx.shadowBlur = 14 * k;
        const L = Math.min(b.width, b.height) * 0.18;
        const pts = [
          [x, y, 1, 1], [x + b.width, y, -1, 1],
          [x, y + b.height, 1, -1], [x + b.width, y + b.height, -1, -1]
        ];
        pts.forEach(function (p) {
          ctx.beginPath();
          ctx.moveTo(p[0] + p[2] * L, p[1]);
          ctx.lineTo(p[0], p[1]);
          ctx.lineTo(p[0], p[1] + p[3] * L);
          ctx.stroke();
        });
        ctx.restore();

        // 68 点关键点 → 按解剖分组画轮廓线（比散点更清晰）
        if (lastFrame.landmarks) {
          ctx.save();
          ctx.strokeStyle = 'rgba(244,114,182,0.78)';
          ctx.lineWidth = 1.6 * k;
          ctx.lineJoin = 'round';
          LM_GROUPS.forEach(function (g) {
            ctx.beginPath();
            for (let i = g[0]; i <= g[1]; i++) {
              const p = lastFrame.landmarks[i];
              if (!p) continue;
              const px = mirrored.value ? (w - p.x) : p.x;
              if (i === g[0]) ctx.moveTo(px, p.y); else ctx.lineTo(px, p.y);
            }
            if (g[2]) ctx.closePath();
            ctx.stroke();
          });
          ctx.restore();
        }

        // 顶部标签
        const ex = lastFrame.expressions;
        let top = 'neutral', tv = -1;
        EMOTION_KEYS.forEach(function (kk) { if ((ex[kk] || 0) > tv) { tv = ex[kk] || 0; top = kk; } });
        const label = EMO_EMOJI[top] + ' ' + SPACE[top].cn + ' ' + (tv * 100).toFixed(0) + '%';
        ctx.save();
        ctx.font = '600 ' + Math.round(15 * k) + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        const tw = ctx.measureText(label).width;
        const padX = 9 * k, hh = 26 * k;
        const bx = Math.max(6, Math.min(w - tw - padX * 2 - 6, x));
        const by = Math.max(6, y - hh - 8 * k);
        ctx.fillStyle = 'rgba(8,6,16,0.82)';
        roundRect(ctx, bx, by, tw + padX * 2, hh, 7 * k);
        ctx.fill();
        ctx.strokeStyle = 'rgba(34,211,238,0.45)';
        ctx.lineWidth = 1 * k;
        ctx.stroke();
        ctx.fillStyle = '#e8f9ff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + padX, by + hh / 2 + 0.5);
        ctx.restore();
      }

      function roundRect(c, x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
      }

      /* ---------------- 检测循环 ---------------- */
      let lastDrawAt = 0;

      function loop(ts) {
        rafId = requestAnimationFrame(loop);

        const isLive = (mode.value === 'camera' || mode.value === 'video');
        // 视频需要每帧重绘；静态图片降频重绘，避免无谓的整图拷贝
        if (isLive || ts - lastDrawAt >= 200) {
          lastDrawAt = ts;
          drawFrame();
        }

        if (!engine.ready) { detecting.value = false; return; }
        const interval = isLive ? 120 : 320;
        const src = isLive ? videoEl : imgEl;
        detecting.value = !!src && (!isLive || (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0));

        if (!src) return;
        if (isLive && (!videoEl || videoEl.readyState < 2)) return;
        if (ts - lastDetectAt < interval) return;
        lastDetectAt = ts;
        detectOnce(src);

        // fps 统计
        fpsCounter++;
        if (!fpsStart) fpsStart = ts;
        if (ts - fpsStart >= 1000) {
          fps.value = Math.round(fpsCounter * 1000 / (ts - fpsStart));
          fpsCounter = 0;
          fpsStart = ts;
        }
      }

      async function detectOnce(src) {
        if (detectingBusy || !engine.ready || !src) return;
        detectingBusy = true;
        detecting.value = true;
        try {
          const f = await engine.detect(src);
          if (f) {
            lastFrame = f;
            faceFound.value = true;
            lastScore.value = f.score;
            faceArea.value = f.areaRatio;
            engine.push(f);
            updateEmotion();
          } else {
            lastFrame = null;
            faceFound.value = false;
            lastScore.value = 0;
            faceArea.value = 0;
          }
        } catch (e) {
          console.warn('detect error', e);
        } finally {
          detectingBusy = false;
        }
      }

      function updateEmotion() {
        const s = engine.smooth();
        if (!s) return;
        emotion.value = s;
        probs.value = s.probs;

        const now = performance.now();
        const moved = Math.abs(s.valence - lastRecV) > 0.06 || Math.abs(s.arousal - lastRecA) > 0.06;
        const strategyChanged = recResult.value && recResult.value.strategy.key !== strategy.value;
        if ((!recResult.value || moved || strategyChanged) && now - lastRecAt > 1100) {
          lastRecAt = now;
          lastRecV = s.valence;
          lastRecA = s.arousal;
          refreshRec();
        }
      }

      /* ---------------- 取像：图片 ---------------- */
      function pickImage() {
        if (!modelReady.value) { toast('模型尚未就绪，请稍候', 'err'); return; }
        imgInput.value && imgInput.value.click();
      }

      function onImage(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        loadImageSrc(URL.createObjectURL(file), true);
        e.target.value = '';
      }

      /** 统一入口：从 URL / Blob URL 载入一张静态图片并立即识别 */
      function loadImageSrc(src, revoke) {
        stopCamera();
        stopVideoEl();
        const img = new Image();
        img.onload = function () {
          if (revoke) { try { URL.revokeObjectURL(src); } catch (er) { /* ignore */ } }
          imgEl = img;
          mode.value = 'image';
          mirrored.value = false;
          lastFrame = null;
          engine.reset();
          setupStage(img.naturalWidth, img.naturalHeight);
          drawFrame();
          // 连续推几帧进入平滑窗口，让置信度快速收敛
          detectOnce(img);
          setTimeout(function () { detectOnce(img); }, 180);
          setTimeout(function () { detectOnce(img); }, 420);
          toast('已载入图片 ' + img.naturalWidth + '×' + img.naturalHeight);
        };
        img.onerror = function () { toast('图片读取失败', 'err'); };
        img.src = src;
      }

      /** 示例图库：无摄像头时一键走完整识别链路（素材为内置 AI 生成的情绪照片） */
      function loadSample() {
        loadImageSrc('test/face-sample2.jpg', false);
      }

      /** 情绪图库：内置 7 张情绪照片，点击任一张即可载入并识别 */
      const FACE_GALLERY = EMOTION_KEYS.map(function (k) {
        return {
          key: k,
          cn: SPACE[k].cn,
          emoji: EMO_EMOJI[k],
          src: 'assets/faces/' + k + '.jpg',
          // 仅影响缩略图显示的放大倍数；识别始终使用原始文件
          zoom: (k === 'disgusted' || k === 'surprised') ? 1.5 : 1
        };
      });
      const showGallery = ref(false);

      function toggleGallery() {
        showGallery.value = !showGallery.value;
      }

      function loadFace(face, keepOpen) {
        if (!keepOpen) showGallery.value = false;
        loadImageSrc(face.src, false);
      }

      /* ---------------- 取像：视频 ---------------- */
      function pickVideo() {
        if (!modelReady.value) { toast('模型尚未就绪，请稍候', 'err'); return; }
        vidInput.value && vidInput.value.click();
      }

      async function onVideo(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        stopCamera();
        const url = URL.createObjectURL(file);
        await playVideoUrl(url, false);
        toast('已打开视频，开始逐帧识别');
        e.target.value = '';
      }

      async function playVideoUrl(url, isCamera) {
        videoEl.pause();
        videoEl.srcObject = null;
        videoEl.loop = true;
        videoEl.src = url;
        try { await videoEl.play(); } catch (err) { /* 用户手势缺失时忽略 */ }
        imgEl = null;
        mode.value = isCamera ? 'camera' : 'video';
        mirrored.value = isCamera;
        engine.reset();
        lastFrame = null;
        const w = videoEl.videoWidth || 640, h = videoEl.videoHeight || 480;
        setupStage(w, h);
        ensureLoop();
      }

      /* ---------------- 取像：摄像头 ---------------- */
      async function toggleCamera() {
        if (!modelReady.value) { toast('模型尚未就绪，请稍候', 'err'); return; }
        if (cameraStream) { stopCamera(); toast('摄像头已关闭'); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          toast('当前浏览器不支持摄像头采集（需 https 或 localhost）', 'err');
          return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: false
          });
          cameraStream = stream;
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.srcObject = stream;
          videoEl.loop = false;
          await videoEl.play();
          imgEl = null;
          mode.value = 'camera';
          mirrored.value = true;
          engine.reset();
          lastFrame = null;
          setupStage(videoEl.videoWidth || 640, videoEl.videoHeight || 480);
          ensureLoop();
          toast('摄像头已开启，请正对镜头', 'ok');
        } catch (err) {
          toast('无法访问摄像头：' + (err.message || err) + '（需允许权限，且页面运行在 localhost 或 https）', 'err');
        }
      }

      function stopCamera() {
        if (cameraStream) {
          cameraStream.getTracks().forEach(function (t) { t.stop(); });
          cameraStream = null;
        }
        if (mode.value === 'camera') {
          videoEl.pause();
          videoEl.srcObject = null;
        }
      }

      function stopVideoEl() {
        try {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.srcObject = null;
          videoEl.load();
        } catch (e) { /* ignore */ }
      }

      /* ---------------- 取像：拍照 ---------------- */
      function capture() {
        if (!videoEl || !videoEl.videoWidth) {
          toast('请先开启摄像头或打开视频，再拍照定格', 'err');
          return;
        }
        const w = videoEl.videoWidth, h = videoEl.videoHeight;
        const snap = document.createElement('canvas');
        snap.width = w; snap.height = h;
        const sctx = snap.getContext('2d');
        if (mirrored.value) {
          sctx.translate(w, 0);
          sctx.scale(-1, 1);
        }
        sctx.drawImage(videoEl, 0, 0, w, h);

        stopCamera();
        stopVideoEl();
        imgEl = snap;
        mode.value = 'snapshot';
        mirrored.value = false;
        engine.reset();
        lastFrame = null;
        setupStage(w, h);
        drawFrame();
        detectOnce(snap);
        setTimeout(function () { detectOnce(snap); }, 180);
        setTimeout(function () { detectOnce(snap); }, 420);
        toast('已定格当前画面并重新识别', 'ok');
      }

      function ensureLoop() {
        if (!rafId) rafId = requestAnimationFrame(loop);
      }

      function resetAll() {
        stopCamera();
        stopVideoEl();
        imgEl = null;
        lastFrame = null;
        engine.reset();
        emotion.value = null;
        probs.value = EMOTION_KEYS.reduce(function (o, k) { o[k] = 0; return o; }, {});
        hasFrame.value = false;
        faceFound.value = false;
        lastScore.value = 0;
        faceArea.value = 0;
        recResult.value = null;
        recItems.value = [];
        simEmotion.value = '';
        if (ctx && stage.value) ctx.clearRect(0, 0, stage.value.width, stage.value.height);
        toast('已重置');
      }

      /* ---------------- 演示模式：手动注入情绪 ---------------- */
      function applySim() {
        if (!simEmotion.value) {
          engine.reset();
          emotion.value = null;
          probs.value = EMOTION_KEYS.reduce(function (o, k) { o[k] = 0; return o; }, {});
          return;
        }
        const p = {};
        const rest = 0.08 / (EMOTION_KEYS.length - 1);
        EMOTION_KEYS.forEach(function (k) { p[k] = (k === simEmotion.value) ? 0.92 : rest; });
        engine.inject(p, 0.95);
        const s = engine.smooth();
        if (s) {
          emotion.value = s;
          probs.value = s.probs;
          refreshRec();
        }
      }

      /* ---------------- 推荐 ---------------- */
      function currentPool() {
        return poolMode.value === 'online' ? allSongs.value : localSongs.value;
      }

      function refreshRec() {
        if (!emotion.value) return;
        const res = recommender.recommend(emotion.value, currentPool(), strategy.value, { k: 8 });
        recResult.value = res;
        recItems.value = res.items;
      }

      function reroll() {
        if (!emotion.value) { toast('先识别一个情绪吧', 'err'); return; }
        // 换一批：把当前前两首临时排除，再走同一套打分 + MMR
        const exclude = (recItems.value || []).slice(0, 2).map(function (x) { return x.song.id; });
        const res = recommender.recommend(emotion.value, currentPool(), strategy.value, { k: 8, excludeIds: exclude });
        recResult.value = res;
        recItems.value = res.items;
      }

      async function switchOnline() {
        if (poolMode.value === 'online') { poolMode.value = 'local'; refreshRec(); return; }
        poolMode.value = 'online';
        if (!emotion.value) { toast('先识别情绪，才能按情绪检索在线歌曲', 'err'); return; }
        if (onlineSongs.value.length) { refreshRec(); return; }
        await fetchOnline(emotion.value.dominant);
      }

      async function fetchOnline(emoKey) {
        onlineLoading.value = true;
        const term = ONLINE_QUERY[emoKey] || 'calm music';
        const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) +
          '&media=music&entity=song&limit=14&country=us';
        let data = null;
        // iTunes Search API 不返回 Access-Control-Allow-Origin，浏览器下必须走 JSONP
        try {
          data = await jsonp(url);
        } catch (e) {
          try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            data = await r.json();
          } catch (e2) { data = null; }
        }
        onlineLoading.value = false;

        if (!data || !data.results) {
          poolMode.value = 'local';
          toast('在线接口暂不可用（可能被网络策略拦截），已回到本地曲库', 'err');
          return;
        }

        const list = data.results.filter(function (t) { return t.previewUrl; }).map(function (t) {
          const feat = MT.inferOnlineFeatures(t, emoKey);
          return {
            id: 'ON' + t.trackId,
            title: t.trackName || '未知曲目',
            artist: t.artistName || 'Unknown',
            emoji: '🎧',
            cover: 'url("' + (t.artworkUrl100 || '').replace('100x100', '200x200') + '") center/cover no-repeat',
            src: t.previewUrl,
            duration: 30,
            source: 'online',
            link: t.trackViewUrl,
            valence: feat.valence, arousal: feat.arousal, energy: feat.energy,
            tempo: feat.tempo, mode: feat.mode, tags: feat.tags,
            note: '在线试听（30 秒），特征由检索语义推断'
          };
        });

        onlineSongs.value = list;
        if (list.length) {
          toast('已从 iTunes 接口取回 ' + list.length + ' 首在线歌曲', 'ok');
          refreshRec();
        } else {
          poolMode.value = 'local';
          toast('在线检索无结果，已回到本地曲库', 'err');
        }
      }

      function jsonp(url) {
        return new Promise(function (resolve, reject) {
          const cb = 'mtCb' + Date.now() + Math.floor(Math.random() * 1000);
          const s = document.createElement('script');
          const timer = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, 9000);
          function cleanup() {
            clearTimeout(timer);
            try { delete window[cb]; } catch (e) { window[cb] = undefined; }
            if (s.parentNode) s.parentNode.removeChild(s);
          }
          window[cb] = function (data) { cleanup(); resolve(data); };
          s.onerror = function () { cleanup(); reject(new Error('script error')); };
          s.src = url + '&callback=' + cb;
          document.body.appendChild(s);
        });
      }

      /* ---------------- 播放器 ---------------- */
      function play(song) {
        current.value = song;
        const a = audio.value;
        if (!a) return;
        a.src = song.src;
        a.volume = volume.value;
        a.play().then(function () {
          playing.value = true;
        }).catch(function (e) {
          playing.value = false;
          toast('播放失败：' + (e.message || '音频不可用'), 'err');
        });
        recommender.markPlayed(song);
      }

      function togglePlay() {
        const a = audio.value;
        if (!a || !current.value) {
          if (recItems.value.length) play(recItems.value[0].song);
          return;
        }
        if (a.paused) { a.play(); playing.value = true; }
        else { a.pause(); playing.value = false; }
      }

      function onTime() {
        const a = audio.value;
        if (!a) return;
        curTime.value = a.currentTime;
        if (a.duration && isFinite(a.duration)) duration.value = a.duration;
      }

      function onMeta() {
        const a = audio.value;
        if (a && a.duration && isFinite(a.duration)) duration.value = a.duration;
      }

      function onEnded() {
        playing.value = false;
        const idx = recItems.value.findIndex(function (x) { return current.value && x.song.id === current.value.id; });
        if (idx >= 0 && recItems.value[idx + 1]) play(recItems.value[idx + 1].song);
      }

      function seek(e) {
        const a = audio.value;
        if (!a || !duration.value) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const p = (e.clientX - rect.left) / rect.width;
        a.currentTime = Math.max(0, Math.min(duration.value, p * duration.value));
      }

      function like(song) {
        const i = likedIds.value.indexOf(song.id);
        if (i >= 0) {
          likedIds.value.splice(i, 1);
          toast('已取消喜欢');
          return;
        }
        likedIds.value.push(song.id);
        const p = recommender.feedback(song, 'like');
        profile.value = { v: p.v, a: p.a, n: p.n };
        toast('已记录偏好：' + song.title + '（本次会话 n=' + p.n + '）', 'ok');
        if (p.n >= 3) refreshRec();
      }

      /* ---------------- 图表计算 ---------------- */
      const emotionKeys = EMOTION_KEYS;
      const emotionSpace = SPACE;

      const topParts = computed(function () {
        return recItems.value.length ? recItems.value[0].parts : null;
      });

      const weightRows = computed(function () {
        const p = topParts.value;
        if (!p) return [];
        const W = { simVA: 0.40, tag: 0.22, energy: 0.14, tempo: 0.10, mode: 0.06, profile: 0.08 };
        return Object.keys(W).map(function (k) {
          return { key: k, label: W_LABEL[k], raw: Math.max(0, Math.min(1, p[k])), contrib: W[k] * p[k] };
        });
      });

      const CX = 110, CY = 110, R = 88;
      function axisAngle(i, n) { return -Math.PI / 2 + i * 2 * Math.PI / n; }

      const radarAxes = computed(function () {
        return EMOTION_KEYS.map(function (k, i) {
          const a = axisAngle(i, EMOTION_KEYS.length);
          return { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R };
        });
      });

      const radarLabels = computed(function () {
        return EMOTION_KEYS.map(function (k, i) {
          const a = axisAngle(i, EMOTION_KEYS.length);
          return { x: CX + Math.cos(a) * (R + 15), y: CY + Math.sin(a) * (R + 15), t: SPACE[k].cn };
        });
      });

      const radarPoints = computed(function () {
        return EMOTION_KEYS.map(function (k, i) {
          const a = axisAngle(i, EMOTION_KEYS.length);
          const r = Math.max(3, (probs.value[k] || 0) * R);
          return (CX + Math.cos(a) * r).toFixed(1) + ',' + (CY + Math.sin(a) * r).toFixed(1);
        }).join(' ');
      });

      const radarDots = computed(function () {
        return EMOTION_KEYS.map(function (k, i) {
          const a = axisAngle(i, EMOTION_KEYS.length);
          const r = Math.max(3, (probs.value[k] || 0) * R);
          return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
        });
      });

      function radarGrid(lv) {
        return EMOTION_KEYS.map(function (k, i) {
          const a = axisAngle(i, EMOTION_KEYS.length);
          return (CX + Math.cos(a) * R * lv).toFixed(1) + ',' + (CY + Math.sin(a) * R * lv).toFixed(1);
        }).join(' ');
      }

      const emotionEmoji = computed(function () {
        return emotion.value ? EMO_EMOJI[emotion.value.dominant] : '🙂';
      });
      const emoDesc = computed(function () {
        return emotion.value ? EMO_DESC[emotion.value.dominant] : '';
      });

      const modeIcon = computed(function () {
        return { image: '🖼️', video: '🎬', camera: '📷', snapshot: '⚡' }[mode.value] || '🎞️';
      });
      const placeholderTitle = computed(function () {
        if (!modelReady.value) return '情绪识别模型加载中…';
        return {
          image: '选择一张含人脸的图片',
          video: '打开一段本地视频',
          camera: '开启摄像头，正对镜头',
          snapshot: '先开启摄像头或视频，再点击拍照'
        }[mode.value];
      });
      const placeholderHint = computed(function () {
        if (!modelReady.value) return '首次加载约需 1~3 秒，模型全部来自本地 /models 目录。';
        return '建议正脸、光线均匀、人脸占画面 15% 以上，识别会更稳定。';
      });

      const cameraOn = computed(function () { return !!cameraStream; });

      const progress = computed(function () {
        return duration.value ? Math.min(100, curTime.value / duration.value * 100) : 0;
      });

      /* ---------------- 生命周期 ---------------- */
      onMounted(function () {
        // 隐藏的视频源（摄像头 / 本地视频共用）
        videoEl = document.createElement('video');
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', '');
        videoEl.muted = true;
        videoEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        document.body.appendChild(videoEl);

        ensureLoop();
        initModels();

        // 支持 ?demo=happy 之类的 URL 参数直接进入演示模式（方便演示/自检）
        try {
          const qs = new URLSearchParams(location.search);
          const d = qs.get('demo');
          if (d && EMOTION_KEYS.indexOf(d) >= 0) {
            simEmotion.value = d;
            setTimeout(applySim, 400);
          }
          if (qs.get('sample') === '1') wantSample = true;
          if (qs.get('gallery') === '1') {
            showGallery.value = true;
            if (!qs.get('sample')) {
              // 直接载入图库第一张，走完整识别链路
              setTimeout(function () { loadFace(FACE_GALLERY[0], true); }, 300);
            }
          }
          if (qs.get('online') === '1') {
            setTimeout(function () { if (emotion.value) switchOnline(); }, 1600);
          }
        } catch (e) { /* ignore */ }

        // 演示模式：持续注入，避免平滑窗口过期
        simTimer = setInterval(function () {
          if (simEmotion.value && engine.ready) {
            const p = {};
            const rest = 0.08 / (EMOTION_KEYS.length - 1);
            EMOTION_KEYS.forEach(function (k) { p[k] = (k === simEmotion.value) ? 0.92 : rest; });
            engine.inject(p, 0.95);
            const s = engine.smooth();
            if (s) {
              emotion.value = s;
              probs.value = s.probs;
              if (!recResult.value) refreshRec();
            }
          }
        }, 700);

        window.addEventListener('keydown', onKey);
      });

      function onKey(e) {
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'Escape') { showAlgo.value = false; showHelp.value = false; }
      }

      onBeforeUnmount(function () {
        if (rafId) cancelAnimationFrame(rafId);
        if (simTimer) clearInterval(simTimer);
        stopCamera();
        stopVideoEl();
        window.removeEventListener('keydown', onKey);
      });

      watch(volume, function (v) {
        if (audio.value) audio.value.volume = v;
      });

      return {
        // 状态
        modelReady, modelError, loadPct, detecting, fps,
        mode, hasFrame, srcW, srcH, lastScore, faceArea, faceFound, mirrored, protocolWarning,
        emotion, probs, simEmotion, stage, imgInput, vidInput,
        localSongs, onlineSongs, allSongs,
        strategy, strategies, recResult, recItems, poolMode, onlineLoading,
        current, playing, curTime, duration, volume, likedIds, profile,
        toasts, showAlgo, showHelp, cameraOn, progress,
        showGallery, FACE_GALLERY, toggleGallery, loadFace,
        // 图表
        emotionKeys, emotionSpace, emotionEmoji, emoDesc,
        radarAxes, radarLabels, radarPoints, radarDots, radarGrid,
        topParts, weightRows,
        modeIcon, placeholderTitle, placeholderHint,
        // 方法
        pickImage, pickVideo, onImage, onVideo, loadSample,
        toggleCamera, capture, resetAll, applySim,
        refreshRec, reroll, switchOnline,
        play, togglePlay, onTime, onMeta, onEnded, seek, like, fmt
      };
    }
  }).mount('#app');
})();
