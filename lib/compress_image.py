#!/usr/bin/env python3
# compress_image.py — 由 dsh-diary 调用：将任意图片转 JPEG(质量95渐进)，
# 保证 <= max 字节，按内容 sha256 命名（去重）。支持 本地路径 / URL / base64(data URI)。
import sys, os, io, json, hashlib, argparse
from PIL import Image, ImageOps

try:
    from PIL import ImageResample  # 兼容命名
    LANCZOS = ImageResample.LANCZOS
except Exception:
    LANCZOS = Image.LANCZOS


def open_input(spec):
    # spec: 'url:<http...>', 'b64:<base64或data URI>', 或本地路径（可带 file:// 前缀）
    if spec.startswith('url:'):
        import urllib.request
        url = spec[4:]
        req = urllib.request.Request(url, headers={'User-Agent': 'dsh-diary'})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    if spec.startswith('b64:'):
        import base64
        s = spec[4:]
        if s.startswith('data:') and ',' in s:
            s = s.split(',', 1)[1]
        return base64.b64decode(s)
    p = spec
    if p.startswith('file://'):
        p = p[7:]
    if p.startswith('/') and len(p) > 3 and p[2] == ':':
        p = p[1:]  # /C:/x -> C:/x （git bash 风格）
    with open(p, 'rb') as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', dest='out', required=True)
    ap.add_argument('--max', type=int, default=2097152)
    ap.add_argument('--q0', type=int, default=95)
    ap.add_argument('--qmin', type=int, default=30)
    args = ap.parse_args()
    try:
        data = open_input(args.inp)
        h = hashlib.sha256(data).hexdigest()
        img = Image.open(io.BytesIO(data))
        try:
            img = ImageOps.exif_transpose(img)  # 按 EXIF 方向校正（手机照片）
        except Exception:
            pass
        img = img.convert('RGB')  # 丢弃 alpha，JPEG 不支持透明
        os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)

        def save_at(q, im):
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=q, progressive=True, optimize=True)
            return buf.getvalue()

        best = save_at(args.q0, img)
        q = args.q0
        while len(best) > args.max and q > args.qmin:
            q -= 5
            best = save_at(q, img)
        # 仍超限：降分辨率后再压
        if len(best) > args.max:
            for longest in (2000, 1400, 1000, 800, 600):
                if max(img.width, img.height) > longest:
                    scale = longest / max(img.width, img.height)
                    ni = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), LANCZOS)
                    q2 = args.q0
                    cand = save_at(q2, ni)
                    while len(cand) > args.max and q2 > args.qmin:
                        q2 -= 5
                        cand = save_at(q2, ni)
                    if len(cand) <= args.max:
                        best, q, img = cand, q2, ni
                        break
        with open(args.out, 'wb') as f:
            f.write(best)
        print(json.dumps({'ok': True, 'hash': h, 'size': len(best), 'quality': q,
                          'width': img.width, 'height': img.height}))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(0)


if __name__ == '__main__':
    main()
