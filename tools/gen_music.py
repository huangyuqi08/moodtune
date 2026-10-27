#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地曲库生成器：用 numpy 合成 14 段免版税演示音乐。
每首曲子按「情绪原型」固定 BPM / 调式 / 音色 / 节奏型，
使音频的实际听感与曲库里标注的 (valence, arousal) 特征一致。
"""
import os
import wave
import numpy as np

SR = 22050
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "music")
os.makedirs(OUT, exist_ok=True)

CHORD = {
    "maj": [0, 4, 7],
    "min": [0, 3, 7],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "sus2": [0, 2, 7],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "min9": [0, 3, 7, 10, 14],
    "dom7": [0, 4, 7, 10],
}


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def osc(freq, dur, kind="sine", detune=0.0):
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    ph = 2 * np.pi * freq * (1 + detune) * t
    if kind == "sine":
        return np.sin(ph)
    if kind == "tri":
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == "saw":
        # 带限近似：叠加若干谐波，避免高频锯齿过冲
        y = np.zeros(n)
        for k in range(1, 9):
            if freq * k > SR / 2.2:
                break
            y += np.sin(ph * k) / k
        return y * 0.7
    if kind == "square":
        y = np.zeros(n)
        for k in range(1, 9, 2):
            if freq * k > SR / 2.2:
                break
            y += np.sin(ph * k) / k
        return y * 0.8
    if kind == "soft":
        return np.sin(ph) + 0.22 * np.sin(2 * ph) + 0.08 * np.sin(3 * ph)
    if kind == "bell":
        return (np.sin(ph) + 0.5 * np.sin(2.01 * ph) * np.exp(-t * 3)
                + 0.25 * np.sin(3.02 * ph) * np.exp(-t * 5))
    return np.sin(ph)


def env(n, attack=0.01, tau=0.3, release=0.0):
    e = np.exp(-np.arange(n) / (tau * SR))
    a = min(n, int(attack * SR))
    if a > 1:
        e[:a] *= np.linspace(0.0, 1.0, a)
    r = int(release * SR)
    if 0 < r < n:
        e[-r:] *= np.linspace(1.0, 0.0, r)
    return e


def add(buf, sig, at):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def kick(dur=0.36, amp=0.55, f0=120, f1=44):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 26)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 9) * amp


def snare(dur=0.22, amp=0.26):
    n = int(dur * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 1, n)
    noise = np.diff(noise, prepend=0)  # 粗高通
    return (noise * 0.5 + np.sin(2 * np.pi * 190 * t) * 0.6) * np.exp(-t * 26) * amp


def hat(dur=0.09, amp=0.09, open_=False):
    n = int((0.3 if open_ else dur) * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(11)
    noise = np.diff(np.diff(rng.normal(0, 1, n), prepend=0), prepend=0)
    return noise * np.exp(-t * (14 if open_ else 60)) * amp


def reverb(x, taps=((0.029, 0.26), (0.043, 0.19), (0.067, 0.13))):
    y = x.copy()
    for d, g in taps:
        k = int(d * SR)
        if k < len(x):
            y[k:] += x[:-k] * g
    return y


def render(cfg):
    bpm = cfg["bpm"]
    beat = 60.0 / bpm
    bar = beat * 4
    bars = cfg["bars"]
    total = bar * bars + 2.0
    n = int(total * SR) + SR
    mix = np.zeros(n)

    prog = cfg["prog"]
    pad_gain = cfg.get("pad", 0.16)
    arp_gain = cfg.get("arp", 0.0)
    bass_gain = cfg.get("bass", 0.28)
    lead_gain = cfg.get("lead", 0.0)
    drums = cfg.get("drums", True)
    swing = cfg.get("swing", 0.0)
    rng = np.random.default_rng(cfg.get("seed", 1))

    for b in range(bars):
        t0 = b * bar
        root, ctype = prog[b % len(prog)]
        tones = [root + i for i in CHORD[ctype]]

        # ---- 铺底 pad（整小节） ----
        for k, m in enumerate(tones):
            d = bar * 1.06
            s = osc(mtof(m), d, cfg.get("pad_kind", "soft"))
            s = s * env(len(s), attack=cfg.get("pad_attack", 0.35), tau=2.2,
                        release=0.25) * pad_gain / len(tones)
            add(mix, s, t0 + k * 0.004)

        # ---- 低音 ----
        if bass_gain > 0:
            bass_pat = cfg.get("bass_pat", [0, 2])
            for bi in bass_pat:
                d = beat * 1.8 if len(bass_pat) == 2 else beat * 0.9
                s = osc(mtof(root - 24), d, "sine") + 0.35 * osc(mtof(root - 12), d, "sine")
                s = s * env(len(s), attack=0.008, tau=0.55) * bass_gain
                add(mix, s, t0 + bi * beat)

        # ---- 琶音 / 分解和弦 ----
        if arp_gain > 0:
            seq = tones + [t + 12 for t in tones]
            steps = cfg.get("arp_steps", 8)
            step = bar / steps
            pattern = cfg.get("arp_pattern")
            for i in range(steps):
                m = pattern[i % len(pattern)] if pattern else seq[i % len(seq)]
                m = root + m
                d = step * 1.6
                s = osc(mtof(m), d, cfg.get("arp_kind", "bell"))
                s = s * env(len(s), attack=0.006, tau=0.22) * arp_gain
                off = 0.0
                if swing and i % 2 == 1:
                    off = step * swing
                add(mix, s, t0 + i * step + off)

        # ---- 主旋律 ----
        if lead_gain > 0:
            scale = cfg.get("scale", [0, 2, 4, 5, 7, 9, 11])
            for i in range(4):
                if rng.random() < cfg.get("lead_density", 0.65):
                    deg = int(rng.integers(0, len(scale)))
                    octv = 12 * int(rng.integers(0, 2))
                    m = root + 12 + scale[deg] + octv
                    d = beat * float(rng.choice([1.0, 1.5, 2.0]))
                    s = osc(mtof(m), d, cfg.get("lead_kind", "bell"))
                    s = s * env(len(s), attack=0.02, tau=0.45) * lead_gain
                    add(mix, s, t0 + i * beat * 1.01)

        # ---- 鼓组 ----
        if drums:
            kp = cfg.get("kick_pat", [0, 2])
            sp = cfg.get("snare_pat", [1, 3])
            hp = cfg.get("hat_pat", [])
            for p in kp:
                add(mix, kick(amp=cfg.get("kick_amp", 0.5)), t0 + p * beat)
            for p in sp:
                add(mix, snare(amp=cfg.get("snare_amp", 0.2)), t0 + p * beat)
            for p in hp:
                add(mix, hat(open_=(p % 1 != 0)), t0 + p * beat)

    # ---- 后处理 ----
    wet = cfg.get("reverb", 0.22)
    mix = (1 - wet) * mix + wet * reverb(mix)
    # 淡入淡出
    fi = int(0.6 * SR)
    fo = int(1.6 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)
    mix[-fo:] *= np.linspace(1, 0, fo)
    peak = float(np.max(np.abs(mix))) or 1.0
    mix = mix / peak * 0.88
    # 软限幅，避免削波失真
    mix = np.tanh(mix * 1.18) * 0.82
    return mix


def write_wav(path, x):
    data = np.clip(x, -1, 1)
    pcm = (data * 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


# 14 首：情绪 → 速度 / 调式 / 音色 / 节奏
D5, D4 = 62, 62
SONGS = [
    dict(slug="sunny-equation", bpm=116, bars=12, seed=3,
         prog=[(60, "maj"), (65, "maj"), (67, "maj"), (69, "min")],
         pad=0.15, arp=0.13, arp_steps=8, bass=0.26, lead=0.10,
         drums=True, kick_pat=[0, 2], snare_pat=[1, 3], hat_pat=[0.5, 1.5, 2.5, 3.5],
         scale=[0, 2, 4, 7, 9]),
    dict(slug="summer-soda", bpm=128, bars=12, seed=9,
         prog=[(62, "maj"), (69, "maj"), (71, "min"), (67, "maj")],
         pad=0.12, arp=0.16, arp_steps=8, bass=0.28, lead=0.12,
         drums=True, kick_pat=[0, 1.5, 2, 3.5], snare_pat=[1, 3],
         hat_pat=[0.5, 1, 1.5, 2.5, 3, 3.5], swing=0.06,
         arp_kind="tri", scale=[0, 2, 4, 7, 9]),
    dict(slug="rain-silence", bpm=62, bars=6, seed=21,
         prog=[(57, "min"), (53, "maj"), (50, "min"), (52, "min")],
         pad=0.26, pad_attack=0.9, pad_kind="soft", bass=0.16, arp=0.05,
         arp_steps=4, arp_kind="sine", drums=False, lead=0.0, reverb=0.42,
         scale=[0, 3, 5, 7, 10]),
    dict(slug="midnight-platform", bpm=72, bars=8, seed=33,
         prog=[(52, "min"), (48, "maj"), (55, "maj"), (50, "min")],
         pad=0.2, bass=0.2, arp=0.08, arp_steps=6, arp_kind="sine",
         drums=True, kick_pat=[0], snare_pat=[2], hat_pat=[1, 3],
         kick_amp=0.3, snare_amp=0.12, reverb=0.5,
         scale=[0, 3, 5, 7, 10]),
    dict(slug="rage-tide", bpm=148, bars=16, seed=5,
         prog=[(54, "min"), (50, "maj"), (57, "maj"), (52, "maj")],
         pad=0.13, pad_kind="saw", arp=0.1, arp_steps=16, arp_kind="saw",
         bass=0.34, bass_pat=[0, 1.5, 2, 3.5], drums=True,
         kick_pat=[0, 1, 2, 3], snare_pat=[1, 3], hat_pat=[0.5, 1.5, 2.5, 3.5],
         kick_amp=0.62, snare_amp=0.28, lead=0.08, lead_kind="saw",
         scale=[0, 1, 3, 5, 7, 8, 10]),
    dict(slug="iron-curtain", bpm=158, bars=16, seed=17,
         prog=[(55, "min"), (51, "maj"), (58, "maj"), (53, "maj")],
         pad=0.12, pad_kind="square", arp=0.09, arp_steps=16, arp_kind="saw",
         bass=0.36, bass_pat=[0, 1, 2, 3], drums=True,
         kick_pat=[0, 0.75, 2, 2.75], snare_pat=[1, 3],
         hat_pat=[0.5, 1.5, 2.5, 3.5], kick_amp=0.65, snare_amp=0.3,
         lead=0.07, lead_kind="square", scale=[0, 1, 3, 5, 6, 8, 10]),
    dict(slug="study-glow", bpm=70, bars=6, seed=41,
         prog=[(53, "maj7"), (50, "min7"), (46, "maj7"), (48, "maj7")],
         pad=0.24, pad_attack=0.7, bass=0.16, arp=0.06, arp_steps=4,
         arp_kind="sine", drums=False, reverb=0.45),
    dict(slug="cloud-walk", bpm=82, bars=8, seed=8,
         prog=[(55, "maj7"), (52, "min7"), (48, "maj7"), (50, "maj7")],
         pad=0.2, pad_attack=0.5, bass=0.18, arp=0.1, arp_steps=8,
         arp_kind="sine", drums=True, kick_pat=[0, 2], snare_pat=[], hat_pat=[1, 3],
         kick_amp=0.28, snare_amp=0.0, reverb=0.38),
    dict(slug="mist-echo", bpm=88, bars=8, seed=61,
         prog=[(49, "min"), (49, "dim"), (44, "aug"), (46, "dim")],
         pad=0.24, pad_kind="soft", pad_attack=0.8, bass=0.14, arp=0.05,
         arp_steps=6, arp_kind="bell", drums=True, kick_pat=[0],
         snare_pat=[], hat_pat=[2.5], kick_amp=0.2, reverb=0.62),
    dict(slug="blank-room", bpm=86, bars=8, seed=13,
         prog=[(50, "min7"), (55, "min7"), (46, "maj7"), (45, "dom7")],
         pad=0.2, bass=0.16, arp=0.07, arp_steps=6, arp_kind="tri",
         drums=True, kick_pat=[0, 2], snare_pat=[1, 3], hat_pat=[1.5, 3.5],
         kick_amp=0.22, snare_amp=0.08, reverb=0.35),
    dict(slug="firework-burst", bpm=132, bars=14, seed=77,
         prog=[(57, "maj"), (52, "maj"), (54, "min"), (50, "maj")],
         pad=0.14, pad_kind="tri", arp=0.14, arp_steps=16, arp_kind="bell",
         bass=0.3, drums=True, kick_pat=[0, 1, 2, 3], snare_pat=[1, 3],
         hat_pat=[0.5, 1.5, 2.5, 3.5], kick_amp=0.58, snare_amp=0.26,
         lead=0.12, lead_kind="bell", lead_density=0.85,
         scale=[0, 2, 4, 7, 9, 11], reverb=0.3),
    dict(slug="starlight-leap", bpm=124, bars=12, seed=29,
         prog=[(59, "maj"), (54, "maj"), (56, "min"), (52, "maj")],
         pad=0.15, arp=0.15, arp_steps=16, arp_kind="bell", bass=0.28,
         drums=True, kick_pat=[0, 1.5, 2, 3], snare_pat=[1, 3],
         hat_pat=[0.5, 1.5, 2.5, 3.5], lead=0.1, lead_density=0.7,
         scale=[0, 2, 4, 7, 9, 11], reverb=0.32),
    dict(slug="healing-dawn", bpm=76, bars=7, seed=52,
         prog=[(51, "maj7"), (46, "maj7"), (48, "min7"), (44, "maj7")],
         pad=0.24, pad_attack=0.8, bass=0.14, arp=0.08, arp_steps=6,
         arp_kind="bell", drums=True, kick_pat=[0], snare_pat=[],
         hat_pat=[2], kick_amp=0.2, reverb=0.5),
    dict(slug="after-rain", bpm=90, bars=9, seed=64,
         prog=[(53, "maj"), (48, "maj"), (50, "min"), (46, "maj")],
         pad=0.18, bass=0.2, arp=0.11, arp_steps=8, arp_kind="tri",
         drums=True, kick_pat=[0, 2], snare_pat=[1, 3], hat_pat=[1.5, 3.5],
         kick_amp=0.3, snare_amp=0.14, lead=0.06, reverb=0.36),
]

if __name__ == "__main__":
    for cfg in SONGS:
        y = render(cfg)
        path = os.path.join(OUT, cfg["slug"] + ".wav")
        write_wav(path, y)
        dur = len(y) / SR
        print("%-22s %5.1fs  %6.2fMB" % (cfg["slug"], dur, os.path.getsize(path) / 1048576))
