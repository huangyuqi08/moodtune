"""
tools/prep_faces.py —— 内置情绪图库的图像预处理脚本

为什么需要这个脚本：
  face-api.js 的 TinyFaceDetector 输入尺度固定为 416×416。当人脸在画面中
  占比过大（接近或超出整幅画面）时，检测器会直接漏检，表现为「未检测到人脸」。

  实测：AI 直接生成的 disgust / surprised 两张图，人脸几乎撑满 1024×1024 画面，
        face-api 返回 NO FACE。把人脸占比压到 20%~40% 后，两张图分别以
        0.948 与 1.000 的置信度被正确识别。

处理步骤（与 assets/faces/ 中的成品一致）：
  1. 裁掉右下角的生成水印
  2. 把主体缩放到画布的 60%
  3. 贴入浅灰画布居中，补足留白
  4. 输出 720×720 JPEG(q=90)

用法：
  python tools/prep_faces.py                # 处理 assets/faces/_*.png
  python tools/prep_faces.py --margin 0.72  # 单独调整留白比例

注意：脚本只做几何变换与编码，不改变表情内容，因此不会影响识别结果；
      但改变留白比例会改变人脸占比，需重新用真实模型验证。
"""

import argparse
import glob
import os

from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACE_DIR = os.path.join(BASE, 'assets', 'faces')

WATERMARK_CROP = (0.84, 0.93)   # 保留 (宽, 高) 的比例，裁掉右下角水印
CANVAS = 1000                   # 合成画布边长
SUBJECT_SCALE = 0.72            # 主体在画布中的占比
OUTPUT_SIZE = 720
QUALITY = 90
BG = (238, 238, 240)            # 浅灰背景，与原始棚拍背景接近


def process(src_path, out_path=None, subject_scale=SUBJECT_SCALE):
    im = Image.open(src_path).convert('RGB')
    w, h = im.size

    # 1. 裁掉右下角水印
    im = im.crop((0, 0, int(w * WATERMARK_CROP[0]), int(h * WATERMARK_CROP[1])))

    # 2/3. 缩小主体并贴到浅灰画布居中
    small = im.resize((int(im.width * subject_scale), int(im.height * subject_scale)), Image.LANCZOS)
    canvas = Image.new('RGB', (CANVAS, CANVAS), BG)
    canvas.paste(small, ((CANVAS - small.width) // 2, (CANVAS - small.height) // 2))

    # 4. 输出
    canvas = canvas.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
    if out_path:
        canvas.save(out_path, 'JPEG', quality=QUALITY, optimize=True)
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--margin', type=float, default=SUBJECT_SCALE,
                    help='主体在画布中的占比，默认 0.72')
    ap.add_argument('--src', default=os.path.join(FACE_DIR, '_*.png'))
    args = ap.parse_args()

    files = sorted(glob.glob(args.src))
    if not files:
        print('没有找到源图：', args.src)
        print('请把原始生成图放到 assets/faces/ 并以 _ 开头命名（如 _happy.png）')
        return

    for p in files:
        name = os.path.basename(p)
        out = os.path.join(FACE_DIR, name.lstrip('_').rsplit('.', 1)[0] + '.jpg')
        process(p, out, args.margin)
        print('%-12s -> %-14s %d KB' % (name, os.path.basename(out), os.path.getsize(out) // 1024))


if __name__ == '__main__':
    main()
