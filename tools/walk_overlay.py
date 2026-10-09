"""把 scripts/walkmap.mjs 的格網疊到正射俯視圖：
綠＝鋪面可走、青＝開放地面可走、黃線＝可走邊界、紅＝邊界外 6 m 內的非鋪面（看起來可能是路但走不過去）、藍＝貼牆。
用法：python3 tools/walk_overlay.py shots/walk [x0,z0,x1,z1 裁切] [輸出檔]"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
d = sys.argv[1]
m = json.load(open(f'{d}/meta.json'))
g = np.frombuffer(open(f'{d}/grid.bin', 'rb').read(), dtype=np.uint8).reshape(m['nz'], m['nx'])
top = Image.open(f'{d}/top.png').convert('RGB')
walk = (g == 0) | (g == 5)
near = ndimage.binary_dilation(walk, iterations=int(6 / m['cell']))
red = near & (g == 4)
edge = walk & ~ndimage.binary_erosion(walk)
s = m['ppm'] * m['cell']
def up(a):
    return np.array(Image.fromarray(a.astype(np.uint8) * 255).resize((m['W'], m['H']), Image.NEAREST)) > 0
A = np.array(top).astype(np.float32)
for mask, col, al in [(up(g == 0), (60, 220, 60), 0.18), (up(g == 5), (0, 230, 255), 0.30), (up(red), (255, 0, 0), 0.45), (up(g == 3), (40, 90, 255), 0.35), (up(edge), (255, 230, 0), 0.9)]:
    A[mask] = A[mask] * (1 - al) + np.array(col) * al
im = Image.fromarray(A.clip(0, 255).astype(np.uint8))
dr = ImageDraw.Draw(im)
for x in range(int(np.ceil(m['x0'] / 20) * 20), int(m['x1']), 20):
    X = (x - m['x0']) * m['ppm']
    dr.line([(X, 0), (X, 6)], fill=(0, 0, 0)); dr.text((X + 1, 7), str(x), fill=(0, 0, 0))
for z in range(int(np.ceil(m['z0'] / 20) * 20), int(m['z1']), 20):
    Z = (z - m['z0']) * m['ppm']
    dr.line([(0, Z), (6, Z)], fill=(0, 0, 0)); dr.text((8, Z - 5), str(z), fill=(0, 0, 0))
if len(sys.argv) > 2 and sys.argv[2] != '-':
    x0, z0, x1, z1 = map(float, sys.argv[2].split(','))
    im = im.crop(((x0 - m['x0']) * m['ppm'], (z0 - m['z0']) * m['ppm'], (x1 - m['x0']) * m['ppm'], (z1 - m['z0']) * m['ppm']))
out = sys.argv[3] if len(sys.argv) > 3 else f'{d}/overlay.jpg'
im.save(out, quality=88)
print(out, im.size, 'walk cells', int(walk.sum()), 'red', int(red.sum()))
