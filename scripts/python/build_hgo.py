import json, math, base64, sys
import numpy as np
from matplotlib.path import Path

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
feats = sorted(d['features'], key=lambda f: f['properties']['CVE_MUN'])
names = [f['properties']['NOMGEO'] for f in feats]
codes = ['13' + f['properties']['CVE_MUN'] for f in feats]

def polys(g):
    return [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']

xs, ys = [], []
for f in feats:
    for p in polys(f['geometry']):
        a = np.array(p[0]); xs += [a[:, 0].min(), a[:, 0].max()]; ys += [a[:, 1].min(), a[:, 1].max()]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
lat0 = (y0 + y1) / 2
kx = math.cos(math.radians(lat0))

sp = 0.0125
dy = sp * math.sqrt(3) / 2
P, R, C = [], [], []
r = 0; y = y0
while y <= y1:
    off = sp / 2 if r % 2 else 0
    c = 0; x = x0 + off / kx
    while x <= x1:
        P.append((x, y)); R.append(r); C.append(c); x += sp / kx; c += 1
    y += dy; r += 1
P = np.array(P); R = np.array(R); C = np.array(C)
lab = np.full(len(P), -1)
for i, f in enumerate(feats):
    for p in polys(f['geometry']):
        inside = Path(np.array(p[0])).contains_points(P)
        for hole in p[1:]:
            inside &= ~Path(np.array(hole)).contains_points(P)
        lab[inside & (lab < 0)] = i

grid = {(int(R[i]), int(C[i])): int(lab[i]) for i in range(len(P))}
def neigh(r, c):
    if r % 2:  # odd rows shifted right
        return [(r, c - 1), (r, c + 1), (r - 1, c), (r - 1, c + 1), (r + 1, c), (r + 1, c + 1)]
    return [(r, c - 1), (r, c + 1), (r - 1, c - 1), (r - 1, c), (r + 1, c - 1), (r + 1, c)]

keep = np.where(lab >= 0)[0]
# local planar coords (km-ish, aspect-correct), centered
X = (P[:, 0] - (x0 + x1) / 2) * kx
Y = (P[:, 1] - (y0 + y1) / 2)
scale = 1.0 / max((x1 - x0) * kx, (y1 - y0)) * 2  # largest extent -> 2 units
X *= scale; Y *= scale

flags = []
for i in keep:
    m = lab[i]; nb = [grid.get(n, -1) for n in neigh(int(R[i]), int(C[i]))]
    state_edge = any(v == -1 for v in nb)
    muni_edge = any(v != m and v != -1 for v in nb)
    flags.append(2 if state_edge else (1 if muni_edge else 0))

n = len(keep)
qx = np.round(X[keep] * 32000).astype('<i2')
qy = np.round(Y[keep] * 32000).astype('<i2')
buf = qx.tobytes() + qy.tobytes() + lab[keep].astype('u1').tobytes() + np.array(flags, 'u1').tobytes()

# centroids (of dots) for labels
cent = []
for i in range(len(feats)):
    s = keep[lab[keep] == i]
    cent.append([round(float(X[s].mean()), 4), round(float(Y[s].mean()), 4), int(len(s))])

def proj(lon, lat):
    return [round((lon - (x0 + x1) / 2) * kx * scale, 4), round((lat - (y0 + y1) / 2) * scale, 4)]

meta = {
    'n': int(n), 'names': names, 'codes': codes, 'cent': cent,
    'pachuca': proj(-98.7591, 20.1011),
    'extent': [round((x1 - x0) * kx * scale, 4), round((y1 - y0) * scale, 4)],
    'spacing': round(sp * scale, 5),
}
json.dump({'meta': meta, 'b64': base64.b64encode(buf).decode()}, open(out, 'w'), ensure_ascii=False)
print(n, 'dots', sum(1 for f in flags if f == 2), 'state-edge', sum(1 for f in flags if f == 1), 'muni-edge', meta['extent'], len(meta and json.dumps(meta)))
print('min dots per muni', min(c[2] for c in cent), names[min(range(84), key=lambda i: cent[i][2])])
