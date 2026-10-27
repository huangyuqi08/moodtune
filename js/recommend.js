/**
 * recommend.js —— 情绪驱动歌曲推荐算法
 * ==================================================================
 * 整体分四段，每一段都可在 UI 的「算法明细」中看到数值。
 *
 * ①  情绪 → 目标音乐画像（Target Profile）
 *     输入的 7 维情绪概率 p 已被 emotion.js 平滑为连续 V/A：
 *        V = Σ p_i·V_i , A = Σ p_i·A_i
 *     再按推荐策略把 (V,A) 搬到"目标象限"：
 *     · 同频共振 resonate：  Vt = V,                 At = A
 *     · 情绪疗愈 heal    ：  Vt = V + 0.42·(1−V)     At = A + 0.30·(0.40−A)
 *     · 提神充电 energize：  Vt = V + 0.25·(1−V)     At = A + 0.45·(1−A)
 *     （疗愈不只提效价，还要把唤醒度拉回 0.40 附近的"舒适区"，避免越听越激动）
 *
 * ②  单曲打分为 6 个可解释因子加权求和
 *     simVA   = exp(−((Vs−Vt)²+(As−At)²) / (2σ²))          σ = 0.34   高斯核
 *     tagScore= 0.65·|tags∩T|/|T| + 0.35·[主导情绪标签命中]
 *     energyFit = 1 − |Es − At|
 *     tempoFit  = 1 − min(1, |BPMs − (58+88·At)| / 70)
 *     modeFit   = 大小调是否与目标效价同向
 *     profFit   = cos(歌曲特征, 用户反馈画像)
 *     score = 0.40·simVA + 0.22·tag + 0.14·energy + 0.10·tempo
 *           + 0.06·mode + 0.08·profFit
 *
 * ③  MMR 多样性重排（避免推 10 首一模一样的歌）
 *     pick = argmax[ λ·score(j) − (1−λ)·max_{i∈已选} sim(i,j) ] , λ = 0.72
 *     sim 由 V-A 距离 + 标签 Jaccard 共同构成
 *
 * ④  在线反馈学习
 *     用户「喜欢」 → profile ← 0.85·profile + 0.15·songFeature
 *     用户「跳过」 → profile ← 0.90·profile − 0.10·songFeature（向反方向微调）
 *     n ≥ 3 后 profFit 才真正生效，避免冷启动就把推荐带偏
 * ==================================================================
 */
(function (global) {
  'use strict';

  const SIGMA = 0.34;
  const MMR_LAMBDA = 0.72;
  const W = { simVA: 0.40, tag: 0.22, energy: 0.14, tempo: 0.10, mode: 0.06, profile: 0.08 };

  const STRATEGIES = {
    heal: {
      key: 'heal', name: '情绪疗愈', icon: '🌱',
      desc: '把情绪往温和正向牵引：提升效价，同时把唤醒度拉回舒适区。',
      target: function (v, a) {
        return {
          v: clamp(v + 0.42 * (1 - v), 0, 1),
          a: clamp(a + 0.30 * (0.40 - a), 0.10, 1)
        };
      }
    },
    resonate: {
      key: 'resonate', name: '同频共振', icon: '🫧',
      desc: '找和你此刻心情同频的歌，先被理解，再慢慢走出来。',
      target: function (v, a) { return { v: v, a: a }; }
    },
    energize: {
      key: 'energize', name: '提神充电', icon: '⚡',
      desc: '明确往上推：保持正向，把唤醒度与能量拉高。',
      target: function (v, a) {
        return {
          v: clamp(v + 0.25 * (1 - v), 0, 1),
          a: clamp(a + 0.45 * (1 - a), 0.15, 1)
        };
      }
    }
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /** 目标标签集合 T */
  function targetTags(dominant, strategy) {
    const MT = global.MoodTune;
    const base = MT.EMOTION_TAGS[dominant] || [];
    if (strategy === 'heal') {
      const heal = MT.HEAL_TAGS[dominant] || [];
      return { list: Array.from(new Set(base.concat(heal))), source: '情绪标签 ∪ 疗愈标签' };
    }
    return { list: base.slice(), source: '情绪标签' };
  }

  /** 两个歌曲之间的相似度（用于 MMR） */
  function pairSim(a, b) {
    const d2 = Math.pow(a.valence - b.valence, 2) + Math.pow(a.arousal - b.arousal, 2);
    const va = Math.exp(-d2 / (2 * 0.30 * 0.30));
    const sa = new Set(a.tags), sb = new Set(b.tags);
    let inter = 0;
    sa.forEach(t => { if (sb.has(t)) inter++; });
    const jac = inter / Math.max(1, sa.size + sb.size - inter);
    return 0.6 * va + 0.4 * jac;
  }

  class Recommender {
    constructor() {
      this.profile = { v: 0.5, a: 0.5, n: 0 };
      this.history = [];     // 已播放
      this.liked = [];
      this.skipped = [];
    }

    /**
     * 主入口
     * @param {object} emo   emotion.js 的 smooth() 结果
     * @param {array}  pool  候选歌曲（本地 + 在线）
     * @param {string} strategyKey
     * @param {object} opts  {k, excludeIds, explore}
     */
    recommend(emo, pool, strategyKey, opts) {
      opts = opts || {};
      const k = opts.k || 8;
      const strategy = STRATEGIES[strategyKey] || STRATEGIES.heal;
      const t = strategy.target(emo.valence, emo.arousal);
      const tags = targetTags(emo.dominant, strategy.key);
      const target = {
        v: t.v, a: t.a, tags: tags.list, tagSource: tags.source,
        bpm: 58 + 88 * t.a,
        emotion: emo
      };

      const exclude = new Set(opts.excludeIds || []);
      const scored = pool
        .filter(s => !exclude.has(s.id))
        .map(s => this.scoreSong(s, target, emo));

      scored.sort((x, y) => y.score - x.score);

      // ---- MMR 重排 ----
      const selected = [];
      const remain = scored.slice();
      const mmrTrace = [];
      while (selected.length < Math.min(k, scored.length)) {
        let best = null, bestVal = -Infinity, bestRedundancy = 0;
        for (let i = 0; i < remain.length; i++) {
          const cand = remain[i];
          let redundancy = 0;
          selected.forEach(sel => {
            redundancy = Math.max(redundancy, pairSim(cand.song, sel.song));
          });
          const val = MMR_LAMBDA * cand.score - (1 - MMR_LAMBDA) * redundancy;
          if (val > bestVal) { bestVal = val; best = cand; bestRedundancy = redundancy; }
        }
        if (!best) break;
        best.mmrValue = bestVal;
        best.redundancy = bestRedundancy;
        selected.push(best);
        mmrTrace.push({
          id: best.song.id, title: best.song.title,
          score: round(best.score), mmr: round(bestVal), redundancy: round(bestRedundancy)
        });
        remain.splice(remain.indexOf(best), 1);
      }

      // MMR 决定「哪些歌入选」，展示时再按综合得分降序，符合直觉
      selected.sort((x, y) => y.score - x.score);

      // 为每条结果生成人话解释
      selected.forEach((r, idx) => {
        r.rank = idx + 1;
        r.reason = this.explain(r, target, strategy);
      });

      return {
        strategy: strategy,
        target: target,
        items: selected,
        trace: mmrTrace,
        all: scored
      };
    }

    /** ② 单曲打分 */
    scoreSong(song, target, emo) {
      const dV = song.valence - target.v;
      const dA = song.arousal - target.a;
      const d2 = dV * dV + dA * dA;
      const simVA = Math.exp(-d2 / (2 * SIGMA * SIGMA));

      // 标签
      const T = target.tags;
      let inter = 0;
      const hitTags = [];
      song.tags.forEach(tg => { if (T.indexOf(tg) >= 0) { inter++; hitTags.push(tg); } });
      const hitRate = T.length ? inter / T.length : 0;
      const emoTags = global.MoodTune.EMOTION_TAGS[emo.dominant] || [];
      const hasDominant = song.tags.some(tg => emoTags.indexOf(tg) >= 0);
      const tagScore = 0.65 * hitRate + 0.35 * (hasDominant ? 1 : 0);

      const energyFit = 1 - Math.abs(song.energy - target.a);
      const tempoTarget = 58 + 88 * target.a;
      const tempoFit = 1 - Math.min(1, Math.abs(song.tempo - tempoTarget) / 70);
      const wantMode = target.v >= 0.6 ? 'major' : 'minor';
      const modeFit = song.mode === wantMode ? 1 : 0.55;

      // 用户画像（反馈学习）
      let profFit = 0.5;
      if (this.profile.n >= 3) {
        const pv = song.valence - this.profile.v;
        const pa = song.arousal - this.profile.a;
        profFit = Math.exp(-(pv * pv + pa * pa) / (2 * 0.30 * 0.30));
      }

      let score = W.simVA * simVA + W.tag * tagScore + W.energy * energyFit +
        W.tempo * tempoFit + W.mode * modeFit + W.profile * profFit;

      // 近期已播降权（在同一会话内避免重复）
      const recent = this.history.slice(-6).indexOf(song.id) >= 0;
      if (recent) score *= 0.82;

      return {
        song: song,
        score: score,
        parts: {
          simVA: simVA, tag: tagScore, energy: energyFit, tempo: tempoFit,
          mode: modeFit, profile: profFit, d2: d2
        },
        hitTags: hitTags,
        recent: recent
      };
    }

    /** 生成推荐理由（带数值，便于答辩讲清"为什么是这首"） */
    explain(r, target, strategy) {
      const s = r.song;
      const p = r.parts;
      const bits = [];
      bits.push(`V-A 距离 ${Math.sqrt(p.d2).toFixed(2)}，相似度 ${(p.simVA * 100).toFixed(0)}%`);
      if (r.hitTags.length) bits.push(`命中标签 ${r.hitTags.slice(0, 3).join(' / ')}`);
      bits.push(`速度 ${s.tempo}BPM vs 目标 ${Math.round(target.bpm)}BPM`);
      if (strategy.key === 'heal') bits.push('服务于「先共情后牵引」的疗愈路径');
      if (r.recent) bits.push('近期播放过，已降权');
      return bits.join(' · ');
    }

    /** ④ 反馈学习 */
    feedback(song, type) {
      // 喜欢：向该曲特征靠拢（α=0.15）；跳过：向反方向微离（α=0.10）
      const alpha = type === 'like' ? 0.15 : 0.10;
      if (type === 'like') {
        this.profile.v = clamp(this.profile.v * (1 - alpha) + song.valence * alpha, 0, 1);
        this.profile.a = clamp(this.profile.a * (1 - alpha) + song.arousal * alpha, 0, 1);
      } else {
        this.profile.v = clamp(this.profile.v * (1 - alpha) + (1 - song.valence) * alpha, 0, 1);
        this.profile.a = clamp(this.profile.a * (1 - alpha) + (1 - song.arousal) * alpha, 0, 1);
      }
      this.profile.n += 1;
      if (type === 'like') this.liked.push(song.id); else this.skipped.push(song.id);
      return this.profile;
    }

    markPlayed(song) {
      if (this.history.indexOf(song.id) < 0) this.history.push(song.id);
    }
  }

  /**
   * 在线歌曲特征推断
   * iTunes 接口只给元数据（无音频特征），因此用"检索语义 + 标题关键词"做启发式估计：
   *   1) 以查询所用情绪的 V/A 原型为基准
   *   2) 标题/曲风关键词修正（remix/dance/edm ↑arousal，acoustic/piano/slow ↓arousal…）
   *   3) 用 trackId 做确定性哈希抖动，保证同一首歌每次特征一致
   */
  function inferOnlineFeatures(track, baseEmotion) {
    const space = global.MoodTune.EMOTION_SPACE;
    const proto = space[baseEmotion] || space.neutral;
    let v = proto.v, a = proto.a;
    const text = ((track.trackName || '') + ' ' + (track.primaryGenreName || '') + ' ' +
      (track.collectionName || '')).toLowerCase();

    const up = [/remix/, /dance/, /club/, /edm/, /electro/, /rock/, /metal/, /pump/];
    const down = [/acoustic/, /piano/, /slow/, /lullaby/, /ballad/, /sleep/, /ambient/, /soft/];
    const bright = [/sun/, /happy/, /love/, /smile/, /shine/, /light/, /good/, /summer/];
    const dark = [/rain/, /cry/, /tears/, /lonely/, /blue/, /hurt/, /broken/, /dark/, /night/];

    up.forEach(re => { if (re.test(text)) a += 0.12; });
    down.forEach(re => { if (re.test(text)) a -= 0.12; });
    bright.forEach(re => { if (re.test(text)) v += 0.07; });
    dark.forEach(re => { if (re.test(text)) v -= 0.07; });

    // 确定性抖动
    let h = 0;
    const key = String(track.trackId || track.trackName || '');
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
    const j1 = ((h % 13) / 12 - 0.5) * 0.10;
    const j2 = (((h >> 3) % 11) / 10 - 0.5) * 0.10;

    v = clamp(v + j1, 0.02, 0.98);
    a = clamp(a + j2, 0.02, 0.98);

    return {
      valence: v,
      arousal: a,
      energy: clamp(0.5 * a + 0.5 * (up.some(re => re.test(text)) ? 0.9 : 0.45), 0.05, 1),
      tempo: Math.round(58 + 88 * a + (((h >> 5) % 9) - 4) * 3),
      mode: v >= 0.55 ? 'major' : 'minor',
      tags: Array.from(new Set([baseEmotion].concat(
        up.some(re => re.test(text)) ? ['energetic'] : [],
        down.some(re => re.test(text)) ? ['calm'] : [],
        bright.some(re => re.test(text)) ? ['bright'] : [],
        dark.some(re => re.test(text)) ? ['dark'] : []
      ))),
      inferred: true
    };
  }

  function round(x) { return Math.round(x * 1000) / 1000; }

  global.MoodTune = global.MoodTune || {};
  global.MoodTune.STRATEGIES = STRATEGIES;
  global.MoodTune.Recommender = Recommender;
  global.MoodTune.inferOnlineFeatures = inferOnlineFeatures;
  global.MoodTune.round = round;
})(window);
