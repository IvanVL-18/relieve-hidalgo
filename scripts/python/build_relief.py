"""Build data for Relieve de Hidalgo v2.

Inputs : dem.npy (728x760 int16, 0.0025 deg, NW corner lon -99.87 lat 21.41)
         osm.json (Overpass elements: rivers, water polygons, places)
         ../geo/Hidalgo.json (INEGI municipios)
Output : relief_v2.json
"""
import json, gzip, base64, math, heapq, sys
import numpy as np
from matplotlib.path import Path

STEP, LON0, LAT1 = 0.0025, -99.87, 21.41
dem = np.load('dem.npy').astype(np.float64)
GH, GW = dem.shape
KX = 111.32 * math.cos(math.radians(20.5)); KZ = 110.57
CELL_KM2 = (STEP * KX) * (STEP * KZ)

def to_cr(lon, lat):  # fractional col,row of cell centres
    return (lon - LON0) / STEP - 0.5, (LAT1 - lat) / STEP - 0.5

# ---------- municipios ----------
lons = LON0 + (np.arange(GW) + 0.5) * STEP; lats = LAT1 - (np.arange(GH) + 0.5) * STEP
LO, LA = np.meshgrid(lons, lats); P = np.c_[LO.ravel(), LA.ravel()]
d = json.load(open('../geo/Hidalgo.json'))
feats = sorted(d['features'], key=lambda f: f['properties']['CVE_MUN'])
muni = np.zeros(len(P), np.uint8)
mpaths = []
for i, f in enumerate(feats):
    g = f['geometry']; polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    for p in polys:
        ins = Path(np.array(p[0])).contains_points(P)
        for h in p[1:]: ins &= ~Path(np.array(h)).contains_points(P)
        muni[ins & (muni == 0)] = i + 1
muni = muni.reshape(GH, GW)
inside = muni > 0
print('muni grid done', inside.sum())

els = json.load(open('osm.json'))

# ---------- stream burning from OSM rivers ----------
def lines_of(e):
    if e['type'] == 'way': return [e.get('geometry', [])]
    return [m.get('geometry', []) for m in e.get('members', []) if m.get('type') == 'way']
river_els = [e for e in els if e.get('tags', {}).get('waterway') == 'river']
burn = np.zeros((GH, GW), bool)
for e in river_els:
    for g in lines_of(e):
        for a, b in zip(g, g[1:]):
            c0, r0 = to_cr(a['lon'], a['lat']); c1, r1 = to_cr(b['lon'], b['lat'])
            n = int(max(abs(c1 - c0), abs(r1 - r0)) * 2) + 1
            for t in np.linspace(0, 1, n + 1):
                c = int(round(c0 + (c1 - c0) * t)); r = int(round(r0 + (r1 - r0) * t))
                if 0 <= r < GH and 0 <= c < GW: burn[r, c] = True
z = dem.copy(); z[burn] -= 25
print('burned cells', burn.sum())

import os
if os.path.exists('hydro.npz'):
    _h = np.load('hydro.npz'); acc = _h['acc']; down = _h['down']; dflat = down.ravel()
else:
    # ---------- priority-flood fill with epsilon (Barnes et al.) ----------
    filled = z.copy()
    closed = np.zeros((GH, GW), bool)
    pq = []
    for r in range(GH):
        for c in (0, GW - 1):
            heapq.heappush(pq, (filled[r, c], r, c)); closed[r, c] = True
    for c in range(1, GW - 1):
        for r in (0, GH - 1):
            heapq.heappush(pq, (filled[r, c], r, c)); closed[r, c] = True
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    EPS = 1e-3
    while pq:
        h, r, c = heapq.heappop(pq)
        for dr, dc in NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < GH and 0 <= cc < GW and not closed[rr, cc]:
                closed[rr, cc] = True
                if filled[rr, cc] <= h: filled[rr, cc] = h + EPS
                heapq.heappush(pq, (filled[rr, cc], rr, cc))
    print('filled')

    # ---------- D8 + accumulation ----------
    dist = [math.hypot(dr * STEP * KZ, dc * STEP * KX) for dr, dc in NB]
    down = np.full((GH, GW), -1, np.int64)
    for k, (dr, dc) in enumerate(NB):
        pass
    best = np.zeros((GH, GW));
    pad = np.pad(filled, 1, constant_values=np.inf)
    for k, (dr, dc) in enumerate(NB):
        nb = pad[1 + dr:1 + dr + GH, 1 + dc:1 + dc + GW]
        s = (filled - nb) / dist[k]
        upd = s > best
        best[upd] = s[upd]
        idx = (np.arange(GH)[:, None] + dr) * GW + (np.arange(GW)[None, :] + dc)
        down[upd] = idx[upd]
    order = np.argsort(-filled, axis=None)
    acc = np.ones(GH * GW)
    dflat = down.ravel()
    for i in order:
        j = dflat[i]
        if j >= 0: acc[j] += acc[i]
    acc = acc.reshape(GH, GW)
    print('acc max km2', acc.max() * CELL_KM2)


    np.savez('hydro.npz', acc=acc, down=down)
# ---------- channel polylines ----------
T = 260                      # ~19 km2 catchment
chan = acc >= T
up_count = np.zeros(GH * GW, np.int32)
for i in np.flatnonzero(chan):
    j = dflat[i]
    if j >= 0 and chan.flat[j]: up_count[j] += 1
visited = np.zeros(GH * GW, bool)
polys = []
sources = [i for i in np.flatnonzero(chan) if up_count[i] == 0]
# start from sources sorted by accumulation reached, so trunks are traced as long lines
for s in sources:
    line = []; i = s
    while True:
        line.append(i)
        if visited[i]: break
        visited[i] = True
        j = dflat[i]
        if j < 0 or not chan.flat[j]: break
        i = j
    if len(line) >= 2: polys.append(line)

def chaikin(pts, it=2):
    for _ in range(it):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2]))
        out.append(pts[-1]); pts = out
    return pts

def near_state(r, c, m=6):
    return inside[max(0, r - m):r + m + 1, max(0, c - m):c + m + 1].any()

rivers_out = []
for line in polys:
    rc = [(i // GW, i % GW) for i in line]
    if not any(near_state(r, c) for r, c in rc[::3] + [rc[-1]]): continue
    pts = [(c, r, acc[r, c]) for r, c in rc]
    pts = chaikin(pts)
    flat = []
    for c, r, a in pts:
        flat += [int(round(c * 8)), int(round(r * 8)), int(min(255, round(math.log2(a / T) * 32)))]
    rivers_out.append(flat)
print('river polylines', len(rivers_out), sum(len(f) // 3 for f in rivers_out), 'pts')

# ---------- water polygons ----------
def assemble(ways):
    ways = [[(p['lon'], p['lat']) for p in w] for w in ways if len(w) >= 2]
    rings = []
    while ways:
        cur = ways.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for k, w in enumerate(ways):
                if w[0] == cur[-1]: cur += w[1:]
                elif w[-1] == cur[-1]: cur += w[::-1][1:]
                elif w[-1] == cur[0]: cur = w[:-1] + cur
                elif w[0] == cur[0]: cur = w[::-1][:-1] + cur
                else: continue
                ways.pop(k); changed = True; break
        if len(cur) >= 4: rings.append(cur)
    return rings

def ring_area_km2(r):
    s = 0
    for a, b in zip(r, r[1:] + r[:1]): s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2 * KX * KZ

def dp(pts, tol):
    if len(pts) < 3: return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a; L = np.hypot(*ab)
    arr = np.array(pts)
    if L == 0: dists = np.hypot(*(arr - a).T)
    else: dists = np.abs(ab[0] * (arr[:, 1] - a[1]) - ab[1] * (arr[:, 0] - a[0])) / L
    k = int(dists.argmax())
    if dists[k] > tol: return dp(pts[:k + 1], tol)[:-1] + dp(pts[k:], tol)
    return [pts[0], pts[-1]]

lakes_out, lake_labels = [], []
for e in els:
    t = e.get('tags', {})
    if not (t.get('natural') == 'water' or t.get('landuse') == 'reservoir'): continue
    if e['type'] == 'way':
        g = e.get('geometry', [])
        outer = assemble([g]) if g else []; inner = []
    else:
        outer = assemble([m.get('geometry', []) for m in e.get('members', []) if m.get('role') == 'outer'])
        inner = assemble([m.get('geometry', []) for m in e.get('members', []) if m.get('role') == 'inner'])
    A = sum(ring_area_km2(r) for r in outer) - sum(ring_area_km2(r) for r in inner)
    if A < 0.04: continue
    rings_q = []
    touch = False
    for ring in outer + inner:
        cr = [to_cr(lon, lat) for lon, lat in ring]
        if any(0 <= int(r) < GH and 0 <= int(c) < GW and near_state(int(r), int(c), 2) for c, r in cr[::max(1, len(cr) // 40)]): touch = True
        s = dp(cr, 0.25)
        rings_q.append([v for c, r in s for v in (int(round(c * 8)), int(round(r * 8)))])
    if not touch: continue
    lakes_out.append({'o': rings_q[:len(outer)], 'i': rings_q[len(outer):]})
    nm = t.get('name')
    if nm and A >= 0.8:
        allp = [p for r in outer for p in r]
        lon = sum(p[0] for p in allp) / len(allp); lat = sum(p[1] for p in allp) / len(allp)
        c, r = to_cr(lon, lat)
        if 0 <= r < GH and 0 <= c < GW and inside[int(r), int(c)]:
            lake_labels.append({'n': nm, 'lon': round(lon, 4), 'lat': round(lat, 4), 'a': round(A, 1)})
print('lakes', len(lakes_out), 'labelled', [l['n'] for l in lake_labels])

# ---------- river labels from OSM names ----------
from collections import defaultdict
by_name = defaultdict(list)
for e in river_els:
    nm = e.get('tags', {}).get('name')
    if not nm or len(nm) < 4: continue
    for g in lines_of(e):
        by_name[nm.strip()].append(g)
river_labels = []
for nm, gs in by_name.items():
    pts_in = []
    for g in gs:
        for a, b in zip(g, g[1:]):
            c, r = to_cr((a['lon'] + b['lon']) / 2, (a['lat'] + b['lat']) / 2)
            if 0 <= r < GH and 0 <= c < GW and inside[int(r), int(c)]:
                seg = math.hypot((b['lon'] - a['lon']) * KX, (b['lat'] - a['lat']) * KZ)
                pts_in.append(((a['lon'] + b['lon']) / 2, (a['lat'] + b['lat']) / 2, seg))
    L = sum(p[2] for p in pts_in)
    if L < 12: continue
    # label at the along-length midpoint
    half, run = L / 2, 0
    for lon, lat, s in pts_in:
        run += s
        if run >= half: break
    pretty = nm[0].upper() + nm[1:]
    pretty = pretty.replace('Rio ', 'Río ')
    river_labels.append({'n': pretty, 'lon': round(lon, 4), 'lat': round(lat, 4), 'km': round(L)})
river_labels.sort(key=lambda x: -x['km'])
# merge duplicates differing only by accent/case
seen, rl = set(), []
for x in river_labels:
    k = x['n'].lower().replace('í', 'i')
    if k in seen: continue
    seen.add(k); rl.append(x)
river_labels = rl[:16]
print('river labels', [(x['n'], x['km']) for x in river_labels])

# ---------- places ----------
places = []
for e in els:
    if e['type'] != 'node': continue
    t = e.get('tags', {}); kind = t.get('place')
    if kind not in ('city', 'town', 'village') or not t.get('name'): continue
    c, r = to_cr(e['lon'], e['lat'])
    if not (0 <= r < GH and 0 <= c < GW): continue
    m = int(muni[int(round(r)), int(round(c))]) if 0 <= round(r) < GH and 0 <= round(c) < GW else 0
    if not m: continue
    pop = t.get('population', '')
    try: pop = int(str(pop).replace(',', '').replace(' ', ''))
    except ValueError: pop = 0
    places.append([t['name'], {'city': 0, 'town': 1, 'village': 2}[kind], round(e['lon'], 4), round(e['lat'], 4), m, pop])
places.sort(key=lambda p: (p[1], -p[5], p[0]))
print('places', len(places), [p[0] for p in places if p[1] == 0])

# ---------- municipio centroids ----------
cent = []
for i in range(len(feats)):
    rr, cc = np.nonzero(muni == i + 1)
    cent.append([round(LON0 + (cc.mean() + 0.5) * STEP, 4), round(LAT1 - (rr.mean() + 0.5) * STEP, 4), int(len(rr))])

# ---------- crop & pack grids ----------
rows = np.where(inside.any(1))[0]; cols = np.where(inside.any(0))[0]
r0, r1 = int(max(rows[0] - 3, 0)), int(min(rows[-1] + 4, GH)); c0, c1 = int(max(cols[0] - 3, 0)), int(min(cols[-1] + 4, GW))
e = dem[r0:r1, c0:c1].astype(np.int32); m = muni[r0:r1, c0:c1]
Hc, Wc = e.shape
dl = np.diff(np.c_[np.zeros((Hc, 1), np.int32), e], axis=1).astype('<i2')
def shift(flat):
    out = []
    for k in range(0, len(flat), 3): out += [flat[k] - c0 * 8, flat[k + 1] - r0 * 8, flat[k + 2]]
    return out
def shift2(flat):
    out = []
    for k in range(0, len(flat), 2): out += [flat[k] - c0 * 8, flat[k + 1] - r0 * 8]
    return out
rv = [shift(f) for f in rivers_out]
lk = [{'o': [shift2(r) for r in L['o']], 'i': [shift2(r) for r in L['i']]} for L in lakes_out]
vec = json.dumps({'rivers': rv, 'lakes': lk}, separators=(',', ':'))
meta = {'W': int(Wc), 'H': int(Hc), 'step': STEP, 'lon0': LON0 + (c0 + .5) * STEP, 'lat0': LAT1 - (r0 + .5) * STEP,
        'names': [f['properties']['NOMGEO'] for f in feats], 'codes': ['13' + f['properties']['CVE_MUN'] for f in feats],
        'cent': cent, 'riverLabels': river_labels, 'lakeLabels': lake_labels, 'places': places}
out = {'meta': meta,
       'elev': base64.b64encode(gzip.compress(dl.tobytes(), 9)).decode(),
       'muni': base64.b64encode(gzip.compress(m.tobytes(), 9)).decode(),
       'vec': base64.b64encode(gzip.compress(vec.encode(), 9)).decode()}
json.dump(out, open('relief_v2.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print('grid', Wc, Hc, 'sizes', len(out['elev']), len(out['muni']), len(out['vec']), 'meta', len(json.dumps(meta)))
np.save('acc.npy', acc)
