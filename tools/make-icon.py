"""生成应用图标 build/icon.png（256x256，供 electron-builder 转 .ico）
纯标准库实现，2x 超采样抗锯齿。"""
import os, zlib, struct

S = 256          # 输出尺寸
SS = 2           # 超采样倍数
W = S * SS

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

C1 = (0x3D, 0x7E, 0xFF)   # 蓝
C2 = (0x6F, 0x4D, 0xFF)   # 紫
BG = (0x14, 0x15, 0x1A)   # 深色（挖孔用）

def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # 四角
    cx = x0 + r if x < x0 + r else (x1 - r if x > x1 - r else x)
    cy = y0 + r if y < y0 + r else (y1 - r if y > y1 - r else y)
    if cx == x and cy == y:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def inside_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

# 画布：RGBA
buf = bytearray()
pad = 6 * SS  # 外边距

for py in range(W):
    row = bytearray()
    for px in range(W):
        # 圆角方形底
        if not inside_round_rect(px, py, pad, pad, W - 1 - pad, W - 1 - pad, 56 * SS):
            row += bytes((0, 0, 0, 0))
            continue

        # 对角渐变
        t = (px + py) / (2 * W)
        col = lerp(C1, C2, t)

        # 中间白色圆角盒子（logo）
        bx0, by0, bx1, by1 = 66 * SS, 62 * SS, 190 * SS, 194 * SS
        if inside_round_rect(px, py, bx0, by0, bx1, by1, 26 * SS):
            col = (255, 255, 255)
            # 两个挖孔（眼睛）
            if inside_circle(px, py, 105 * SS, 128 * SS, 15 * SS) or \
               inside_circle(px, py, 151 * SS, 128 * SS, 15 * SS):
                col = BG
        row += bytes((col[0], col[1], col[2], 255))
    buf += row

# 超采样降采样
out = bytearray()
for y in range(S):
    row = bytearray()
    for x in range(S):
        r = g = b = a = 0
        for dy in range(SS):
            for dx in range(SS):
                i = ((y * SS + dy) * W + (x * SS + dx)) * 4
                r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]
        n = SS * SS
        row += bytes((r // n, g // n, b // n, a // n))
    out += row

def write_png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

os.makedirs('build', exist_ok=True)
write_png('build/icon.png', S, S, out)
print('已生成 build/icon.png', os.path.getsize('build/icon.png'), 'bytes')
