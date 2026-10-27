# MoodTune · 基于人脸情绪识别的歌曲推荐系统

纯前端实现（HTML5 + CSS3 + JavaScript + Vue 3），**情绪识别完全本地离线运行**，
无需任何后端服务与 API Key。四种方式获取人脸（图片 / 视频 / 摄像头 / 拍照），
识别情绪后按三种策略生成个性化歌单，可播放 14 首本地曲目或在线拉取 iTunes 试听片段。

---

## 一、快速启动

> ⚠️ **必须通过 HTTP 打开**。浏览器的安全策略禁止 `file://` 页面用 fetch 读取模型文件，
> 直接双击 `index.html` 会看到提示而无法识别。

**Windows**：双击目录下的 `start.bat`，浏览器访问 <http://localhost:8080>

**命令行**：

```bash
cd <本项目目录>
python -m http.server 8080
# 然后访问 http://localhost:8080
```

摄像头采集要求页面运行在 `localhost` 或 `https` 下（`http://127.0.0.1` 亦可）。

---

## 二、目录结构

```
WEEK09/
├── index.html              # 页面骨架 + Vue 内联模板 + 算法说明弹窗
├── start.bat               # Windows 一键启动（内置 python http.server）
├── css/style.css           # 全部样式（深靛蓝玻璃拟态主题，含响应式）
├── js/
│   ├── songs.js            # 曲库数据 + 情绪原型表 + 标签映射
│   ├── emotion.js          # 情绪识别引擎（模型加载 / 检测 / 平滑 / V-A 映射）
│   ├── recommend.js        # 推荐算法（目标画像 / 六因子打分 / MMR / 反馈学习）
│   └── app.js              # Vue 3 应用逻辑（取像、绘制、播放器、在线检索）
├── lib/
│   ├── vue.global.prod.js  # Vue 3.5 本地副本
│   └── face-api.js         # face-api（含 TensorFlow.js 4.22）本地副本
├── models/                 # 三个离线模型，共约 600KB
│   ├── tiny_face_detector_model-weights_manifest.json / .bin
│   ├── face_expression_model-weights_manifest.json / .bin
│   └── face_landmark_68_tiny_model-weights_manifest.json / .bin
├── music/                  # 14 首本地曲目（WAV / 22050Hz / 单声道）
├── assets/faces/           # 内置情绪图库：7 张情绪照片（JPG，共约 600KB）
│   ├── neutral.jpg  happy.jpg  sad.jpg  angry.jpg
│   └── fearful.jpg  disgusted.jpg  surprised.jpg
├── test/                   # 示例照片（用于「🧪 示例照片」按钮，取自 face-api 官方 examples）
└── tools/gen_music.py      # 本地曲库的合成脚本（可重新生成全部音频）
```

---

## 三、情绪识别算法（明确说明）

### 3.1 模型栈（全部本地）

| 模型 | 作用 | 结构 |
|---|---|---|
| `tiny_face_detector` | 人脸检测 | MobileNetV1 + SSD，输入 416×416，输出人脸框与置信度 |
| `face_landmark_68_tiny` | 68 点关键点 | 轻量回归网络，用于人脸对齐与叠框可视化 |
| `face_expression` | 表情分类 | 卷积网络，输入 64×64 灰度人脸，softmax 输出 7 类概率 |

推理流程：`图像 → 人脸检测 → 裁剪对齐到 64×64 → CNN 前向 → 7 维表情概率`。

7 类输出：`neutral / happy / sad / angry / fearful / disgusted / surprised`。

### 3.2 三层后处理增强

1. **质量门控**
   检测分数 < 0.42 或人脸面积占画面 < 1.2% 的帧直接丢弃，避免噪声污染时序结果。

2. **时间平滑（指数加权移动平均 EWMA）**

   ```
   w_k = score_k · exp( −(now − t_k) / 900ms )
   p_smooth(i) = Σ_k w_k·p_k(i) / Σ_k w_k        (窗口 2000ms)
   ```

   作用：抑制单帧抖动。摄像头模式下每 120ms 推理一次，2 秒窗口内约 16 帧参与加权。

3. **连续情感映射（Russell 环形模型）**

   ```
   V (valence 效价) = Σ_i p_smooth(i) · V_i
   A (arousal 唤醒) = Σ_i p_smooth(i) · A_i
   ```

   情绪原型坐标：

   | 情绪 | V | A | 情绪 | V | A |
   |---|---|---|---|---|---|
   | happy | 0.86 | 0.70 | disgusted | 0.24 | 0.46 |
   | sad | 0.16 | 0.26 | surprised | 0.62 | 0.84 |
   | angry | 0.22 | 0.88 | neutral | 0.50 | 0.44 |
   | fearful | 0.28 | 0.64 | | | |

   把 7 类离散概率投影为二维连续坐标，推荐阶段在连续空间中计算距离，
   避免"识别结果每帧跳变导致歌单反复重排"。

### 3.3 置信度定义

```
confidence = [ 0.35·min(1, n/3) + 0.40·p(top1) + 0.25·(p(top1)−p(top2)) ]
             × (0.60 + 0.40·quality)
quality    = 0.55·(检测分归一化) + 0.45·(人脸面积归一化)
```

同时输出**稳定度**：窗口内主导情绪一致帧的占比，用于判断识别是否可信。

---

## 四、歌曲推荐算法（明确说明）

### 第 1 步 · 情绪 → 目标音乐画像

按策略把当前 (V, A) 搬到目标象限：

```
情绪疗愈 heal   : Vt = V + 0.42·(1 − V)      At = A + 0.30·(0.40 − A)
同频共振 resonate: Vt = V                    At = A
提神充电 energize: Vt = V + 0.25·(1 − V)      At = A + 0.45·(1 − A)
目标 BPM        : BPMt = 58 + 88·At
```

疗愈策略不只提升效价，还把唤醒度拉回 0.40 附近的"舒适区"——避免越推越激动。

### 第 2 步 · 六因子打分（每首候选曲）

```
simVA   = exp( −((Vs−Vt)² + (As−At)²) / (2σ²) )        σ = 0.34   高斯核
tag     = 0.65·|tags ∩ T| / |T| + 0.35·[主导情绪标签命中]
energy  = 1 − |Es − At|
tempo   = 1 − min(1, |BPMs − BPMt| / 70)
mode    = 大小调是否与目标效价同向（一致 1，否则 0.55）
profile = exp( −‖歌曲特征 − 用户画像‖² / (2·0.30²) )    仅在 n ≥ 3 时生效

score = 0.40·simVA + 0.22·tag + 0.14·energy
      + 0.10·tempo + 0.06·mode + 0.08·profile
```

标签集合 T：`heal` 策略取「情绪标签 ∪ 疗愈标签」，其余取情绪标签。
近期已播歌曲额外 ×0.82 降权。

### 第 3 步 · MMR 多样性重排

单纯按分数排序会让 Top8 全是同一种歌，因此用最大边际相关（Maximal Marginal Relevance）：

```
pick = argmax_j [ λ·score(j) − (1−λ)·max_{i∈已选} sim(i, j) ]     λ = 0.72
sim(i,j) = 0.6·exp(−V-A 距离² / (2·0.30²)) + 0.4·Jaccard(tags)
```

MMR 决定"哪些歌入选"，列表展示再按综合得分降序。

### 第 4 步 · 在线反馈学习

```
点击 ♥ ：profile ← 0.85·profile + 0.15·歌曲特征
跳过   ：profile ← 0.90·profile + 0.10·(1 − 歌曲特征)
```

n ≥ 3 后 `profile` 项才真正参与打分，避免冷启动就把推荐带偏。
右侧面板实时显示用户画像的 (V, A) 与样本数。

---

## 五、曲库与在线接口

### 5.1 本地曲库（14 首，离线可播）

`music/` 下的音频由 `tools/gen_music.py` 用 numpy 合成，每首 24~30 秒，
按情绪原型严格设定 BPM / 调式 / 音色 / 节奏型，因此标注的 (V, A) 与听感一致：

| 曲目 | 情绪定位 | BPM | V / A |
|---|---|---|---|
| 阳光方程式 | happy | 116 | 0.86 / 0.68 |
| 夏日橙汽水 | happy（舞曲化） | 128 | 0.90 / 0.80 |
| 雨落无声 | sad | 62 | 0.14 / 0.22 |
| 深夜站台 | sad | 72 | 0.22 / 0.34 |
| 怒潮 | angry | 148 | 0.20 / 0.92 |
| 铁幕 | angry（工业） | 158 | 0.16 / 0.96 |
| 微光自习室 | neutral（专注） | 70 | 0.55 / 0.30 |
| 云端漫步 | calm / dreamy | 82 | 0.66 / 0.38 |
| 迷雾回声 | fearful（不协和） | 88 | 0.24 / 0.58 |
| 空白房间 | neutral（极简） | 86 | 0.46 / 0.42 |
| 烟花爆破 | surprised | 132 | 0.70 / 0.86 |
| 星光跃迁 | surprised / hope | 124 | 0.76 / 0.80 |
| 疗愈晨光 | heal（目标曲） | 76 | 0.70 / 0.32 |
| 雨后初晴 | heal / hope | 90 | 0.74 / 0.48 |

重新生成：`python tools/gen_music.py`（需 numpy）。

### 5.2 在线接口

点击「本地 + 在线 API」后调用 **iTunes Search API**：

```
https://itunes.apple.com/search?term=<情绪关键词>&media=music&entity=song&limit=14
```

- 无需 API Key，返回 30 秒官方试听片段（`previewUrl`）。
- 该接口**不返回 CORS 头**，因此浏览器端走 **JSONP**（已实测 `callback` 参数可用），fetch 作为兜底。
- 接口只给元数据、不含音频特征，故用启发式推断其 V/A：
  1. 以查询情绪的 (V, A) 原型为基准；
  2. 标题/曲风关键词修正（`remix/dance/edm` ↑arousal，`acoustic/piano/slow` ↓arousal，`sun/love/shine` ↑valence，`rain/cry/lonely` ↓valence）；
  3. 用 `trackId` 做确定性哈希抖动，保证同一首歌特征恒定。
- 结果在列表中标注「在线」以示区分。

---

## 六、界面功能

- **四路取像**：图片上传 / 本地视频逐帧 / 摄像头实时（自动镜像）/ 拍照定格。
- **叠加绘制**：人脸框四角标记 + 68 点五官轮廓线 + 实时情绪标签（镜像在绘制阶段完成，文字不翻转）。
- **情绪面板**：7 类概率条、情绪雷达图、V–A 情感平面（含目标点与全部曲目散点）。
- **算法明细**：目标画像、Top1 得分六因子构成、用户反馈画像、MMR 重选过程。
- **播放器**：底部常驻，进度拖拽、音量、自动续播；空格键播放/暂停。
- **演示模式**：控制条下拉框可手动注入情绪；URL 参数 `?demo=happy` 亦可。
- **示例照片**：`🧪 示例照片` 按钮一键走完整识别链路（无摄像头时演示用）。
- **内置情绪图库**：`🖼️ 情绪图库` 按钮展开 7 张情绪照片，点击任一张即载入识别，
  当前识别情绪对应的缩略图会高亮。

URL 快捷参数：

```
?demo=happy          手动注入情绪（happy/sad/angry/fearful/disgusted/surprised/neutral）
?sample=1            自动载入示例照片并识别
?gallery=1           展开情绪图库，并自动载入第一张（neutral）识别
&online=1            自动拉取在线歌曲
```

---

## 七、内置情绪图库

`assets/faces/` 下内置 7 张情绪照片，与模型输出的 7 类表情一一对应，
每张都经过真实模型实测，识别结果与预期情绪完全一致：

| 文件 | 情绪 | 实测置信度 | 次高项 |
|---|---|---|---|
| `happy.jpg` | 开心 | 1.000 | sad 0.000 |
| `sad.jpg` | 悲伤 | 1.000 | fearful 0.000 |
| `angry.jpg` | 愤怒 | 0.952 | neutral 0.045 |
| `fearful.jpg` | 恐惧 | 0.999 | sad 0.001 |
| `disgusted.jpg` | 厌恶 | 0.948 | angry 0.052 |
| `surprised.jpg` | 惊讶 | 1.000 | fearful 0.000 |
| `neutral.jpg` | 平静 | 0.993 | angry 0.005 |

**为什么需要专门做图像预处理**：TinyFaceDetector 的输入尺度是 416×416，
当人脸在画面中占比过大（接近或超出整幅画面）时检测器会直接漏检——
最初生成的 `disgusted` 与 `surprised` 两张即因人脸撑满画面而返回「未检测到人脸」。
解决办法是给图片四周补上背景、把人脸占比压到 20%~40% 区间，
两张图的置信度随即从「漏检」提升到 0.948 与 1.000。

处理流程（`tools/` 中的思路可复现）：
```
原始生成图 → 裁掉右下角水印 → 缩放至画面 60% → 贴入浅灰画布居中 → 720×720 JPEG(q=90)
```

> 图库缩略图的显示放大倍数与识别用的原图相互独立：
> `disgusted` / `surprised` 两张原图留白较多，仅在缩略图上用 CSS `transform: scale()` 放大显示，
> 识别始终读取未经变换的原始文件。

---

## 八、已知限制

1. **表情模型对光照与角度敏感**：侧脸、逆光、戴墨镜时置信度会明显下降，建议正脸、光线均匀。
2. **静态图片只推理有限帧**：置信度需要几帧才收敛，图片模式下会以 320ms 间隔补算几次。
3. **在线歌曲特征为推断值**：iTunes 不提供音频特征，排序精度低于本地曲库（这是有意标注「在线」的原因）。
4. **首次加载需 1~3 秒**：三个模型共约 600KB，加载后缓存在浏览器中。
5. `music/` 为合成音频，用于演示与算法验证；替换成真实曲目时，请同步维护 `js/songs.js` 中的 (V, A, energy, tempo, tags) 元数据。
6. **人脸占比过大会导致漏检**：与图库处理同理，输入自己拍的照片时，人脸不宜占满整个画面。
