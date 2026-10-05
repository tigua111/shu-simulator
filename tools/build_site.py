"""世新大學場地資料產生器。

來源：OpenStreetMap（ODbL）建物與步道、國土測繪中心正射影像判讀、官網樓層。
輸出：
  /home/ubuntu/shucampus/src/campus/site.ts   遊戲用資料（場景座標：x 向東、z 向南，原點 = 本地 (OX,OY)）
  /home/ubuntu/geo/site_check_*.jpg             疊在航照上的驗證圖
本地座標：x 向東、y 向北（公尺），原點 LAT0/LON0（frame.json）。
"""
import json, math, sys
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union

GEO = '/home/ubuntu/geo'
f = json.load(open(f'{GEO}/frame.json'))
LAT0, LON0 = f['LAT0'], f['LON0']
K = 111320 * math.cos(math.radians(LAT0))
OX, OY = 330.0, 180.0  # 場景原點（舍我樓附近）
BOUNDS = dict(x0=-20, x1=720, y0=-105, y1=335)

d = json.load(open(f'{GEO}/osm.json'))
N, W = d['nodes'], d['ways']


def xy(nid):
    lat, lon = N[nid]
    return ((lon - LON0) * K, (lat - LAT0) * 110574)


def way_pts(wid):
    return [xy(n) for n in W[str(wid)]['nds'] if n in N]


def ring(wid):
    p = way_pts(wid)
    if p[0] == p[-1]:
        p = p[:-1]
    return p


# ─── 校舍（編號依官方導覽圖） ──────────────────────────────
FLOOR = 3.8
CAMPUS = [
    # id, num, name, code, osm, floors, style
    ('J', '02', '新聞大樓', 'J', 245410602, 5, 'pinkTile'),
    ('W', '03', '世界大廈', 'W', 245407007, 5, 'pinkTile'),
    ('LW', '', '生活之窗', '', 245407011, 1, 'pinkTile'),
    ('D1', '04', '翠谷餐廳', '', 245407457, 3, 'pinkTile'),
    ('D2', '04', '女生第一宿舍', '', 245407458, 6, 'pinkTile'),
    ('D3', '04', '男生第二宿舍', '', 245407460, 5, 'pinkTile'),
    ('ADM', '05', '行政大樓', '', 245407012, 5, 'pinkTile'),
    ('B', '10', '廣電大樓 B', 'B', 245407459, 4, 'brick'),
    ('T', '07', '廣電大樓 T', 'T', 661297406, 3, 'brick'),
    ('T2', '', '廣電附屬', '', 661297407, 2, 'brick'),
    ('L', '08', '圖書館', 'L', 224498220, 6, 'whiteTile'),
    ('L1', '08', '第一閱覽室', '', 245407592, 4, 'whiteTile'),
    ('G', '09', '通識大樓', 'G', 245407593, 7, 'whiteTile'),
    ('SX', '', '舍我樓附屬（便利商店）', '', 245408159, 2, 'brick'),
    ('A', '17', '大禮堂', 'A', 244708179, 6, 'auditorium'),
    ('C', '19', '傳播大廈', 'C', 245408160, 6, 'whiteTile'),
    ('V', '21', '智能攝製基地', '', 245411850, 2, 'concrete'),
    ('M', '11', '管院大樓', 'M', 245422655, 7, 'pinkTile'),
    ('OM', '20', '全媒體大樓', 'O', 512644447, 8, 'glass'),
    ('NS', '', '新苑宿舍', '', 1274288716, 12, 'whiteTile'),
]
buildings = []
for bid, num, name, code, osm, floors, style in CAMPUS:
    buildings.append(dict(id=bid, num=num, name=name, code=code, osm=osm, floors=floors, style=style, poly=ring(osm)))

# 舍我樓（2026-10-04 依使用者紅框照片 DJI_0042_022、0037_039 與 0045_063–078 重建；
# 量測底圖為 NLSC 正射 4 倍放大＋5 m 格線 she_zoom.jpg）。OSM 輪廓 245404436 把前庭也包進樓內，不再沿用。
#   S  北側主塔：東西向長板樓 13F（層高約 3.3 m，總高約 44 m；本模型以 3.8 m 層高換算為 11.5 層），屋頂平頂設備＋大水塔，東端緊鄰 SX
#   SE 入口棟：主塔西南、面向前庭的 10F，中段樓梯窗帶；一樓穿堂讓有頂步道（z≈-39）東西貫通
#   R  南翼：西延的 9F 長翼（北面拱廊立面，0042_030 判讀北面約在 z -35，與 OSM -36 相符），三段斜屋頂，北面為退台陽台；西端半圓樓梯塔另由 world.ts 建
#   前庭：主塔南側、入口棟東側的粉紅色鋪面，東接學校廣場
def L(x, z):
    return (x + OX, OY - z)


def LP(pts):
    return [L(x, z) for x, z in pts]


buildings.append(dict(id='R', num='12', name='舍我樓 R', code='R', osm=245404436, floors=8.5, style='brick',
                      poly=LP([(-31, -18), (6, -18), (6, -22), (12.5, -22), (12.5, -30.5), (2.5, -30.5), (2.5, -35), (-31, -35)])))
buildings.append(dict(id='S', num='13', name='舍我樓 S', code='S', osm=245404436, floors=11.5, style='brick',
                      poly=LP([(3, -47.5), (36, -47.5), (36, -62.5), (3, -62.5)])))
buildings.append(dict(id='SE', num='', name='舍我樓 入口棟', code='', osm=245404436, floors=9.5, style='brick',
                      poly=LP([(2.5, -30.5), (12.5, -30.5), (12.5, -38), (16.5, -38), (16.5, -47.5), (3, -47.5)]),
                      ground=[LP([(3, -47.5), (16.5, -47.5), (16.5, -41.5), (3, -41.5)]), LP([(2.5, -36.5), (12.5, -36.5), (12.5, -30.5), (2.5, -30.5)])],
                      groundH=4.6))

# 主塔西面基座的半圓形一層裙樓（DJI_0038_053：弧形窗帶、冷氣機、頂部植栽），圓心在主塔西牆中段
_arc = [(3 + 7.5 * math.cos(math.radians(a)), -55 + 7.5 * math.sin(math.radians(a))) for a in range(90, 271, 15)]
buildings.append(dict(id='SW', num='', name='舍我樓 西側弧形裙樓', code='', osm=245404436, floors=1, style='brick', poly=LP(_arc)))
campus_ids = {b['osm'] for b in buildings}
campus_union = unary_union([Polygon(b['poly']).buffer(0) for b in buildings])

# ─── 周邊建物（OSM building，非校舍） ─────────────────────
neighbors = []
SKIP = {245404436, 757234924, 860663816, 860663831, 860663853}  # 後三者為舍我樓前庭／主塔旁的 OSM 小量體，實景為前庭鋪面與樓梯塔
for wid, w in W.items():
    t = w['tags']
    if 'building' not in t or int(wid) in campus_ids or int(wid) in SKIP:
        continue
    try:
        p = ring(wid)
    except Exception:
        continue
    if len(p) < 3:
        continue
    poly = Polygon(p).buffer(0)
    if poly.area < 12:
        continue
    c = poly.centroid
    if not (BOUNDS['x0'] < c.x < BOUNDS['x1'] and BOUNDS['y0'] < c.y < BOUNDS['y1']):
        continue
    if poly.intersection(campus_union).area > 0.3 * poly.area:
        continue
    lv = t.get('building:levels')
    try:
        floors = int(float(lv)) if lv else None
    except ValueError:
        floors = None
    if floors is None:
        floors = 2 + (int(wid) % 3) if poly.area < 120 else 4 + (int(wid) % 2)
    neighbors.append(dict(osm=int(wid), floors=floors, poly=list(poly.exterior.coords)[:-1] if poly.geom_type == 'Polygon' else p))

# ─── 道路與步道 ─────────────────────────────────────────
# kind: road / lane / footway / steps / covered / tunnel
PATHS = [
    # 前校門 → 隧道 → 坡道（主動線）
    ('gate-lane', 'lane', 7, 243939383),
    ('tunnel', 'tunnel', 7, 243939384),
    ('ramp-1', 'lane', 7, 243939385),
    ('ramp-2', 'lane', 6, 245410247),
    ('gate-walk', 'footway', 2.5, 322731840),
    ('w-steps', 'steps', 2.5, 245407010),
    ('dorm-walk', 'footway', 2.5, 661297405),
    ('plaza-link', 'footway', 3, 757237638),
    ('lib-steps-1', 'steps', 3, 245445681),
    ('lib-steps-2', 'steps', 3, 245445682),
    ('lib-steps-3', 'steps', 3, 245445680),
    ('lib-path', 'footway', 2, 246155759),
    ('she-north', 'footway', 4, 245410243),
    ('she-arcade', 'footway', 4, 245410244),  # 穿過舍我樓入口棟一樓穿堂與前庭（前庭為露天）
    ('she-south', 'footway', 5, 245410245),
    ('to-broadcast', 'footway', 3, 739045069),
    # 學校廣場以東
    ('backgate-walk', 'footway', 4, 245408158),
    ('aud-steps-w', 'steps', 4, 245445679),
    ('aud-steps-e', 'steps', 4, 245445678),
    ('aud-north', 'footway', 4, 245408156),
    ('track-north', 'footway', 4, 245411848),
    ('c-walk-1', 'footway', 2.5, 736958871),
    ('c-walk-2', 'footway', 2.5, 736958872),
    ('c-walk-3', 'footway', 2.5, 736958873),
    ('c-walk-4', 'footway', 2.5, 736958874),
    ('c-steps-1', 'steps', 2.5, 739043458),
    ('c-steps-2', 'steps', 2.5, 739043459),
    ('c-walk-5', 'footway', 2.5, 739043460),
    ('c-service', 'lane', 5, 245411849),
    # 校外道路
    ('muzha-w', 'road', 11, 229068619),
    ('muzha-e', 'road', 14, 111484734),
    ('shiyuan-main', 'road', 7, 245409759),
    ('shiyuan-w1', 'road', 6, 1072943803),
    ('shiyuan-w2', 'road', 6, 1072943802),
    ('shiyuan-s', 'road', 6, 380194848),
    ('shiyuan-s2', 'road', 6, 1072943804),
    ('shiyuan-5', 'road', 5, 380195549),
    ('shiyuan-144', 'road', 5, 244708155),
    ('shiyuan-154', 'road', 5, 244708173),
    ('shiyuan-60', 'road', 6, 245576887),
    ('muzha-59', 'road', 6, 105822438),
    ('muzha-59-11', 'road', 5, 378640918),
]
paths = []
for pid, kind, w, osm in PATHS:
    if str(osm) not in W:
        print('missing path', pid, osm, file=sys.stderr)
        continue
    pts = way_pts(osm)
    paths.append(dict(id=pid, kind=kind, w=w, osm=osm, pts=pts))

# 舍我樓西側中庭（DJI_0038_053 使用者藍線標示）：
#   沿主塔弧形裙樓西緣北上的小徑，接往北側巷弄的階梯；中庭西緣往西進樹林的階梯
paths.append(dict(id='she-yard-n', kind='footway', w=2.2, osm=0, pts=LP([(-9.5, -44.5), (-10.5, -52), (-9, -60), (-5.5, -66.5), (-3.5, -71)])))
paths.append(dict(id='she-yard-n-steps', kind='steps', w=2.2, osm=0, pts=LP([(-3.5, -71), (-2, -79)])))
paths.append(dict(id='she-yard-w-steps', kind='steps', w=2.2, osm=0, pts=LP([(-13, -43), (-18.5, -46), (-24, -47.5)])))
# 舍我樓前庭南側（DJI_0042_128 使用者藍框）：由大禮堂西側往西接 she-south 的灰色水泥車道、前庭西南角上前庭的階梯
paths.append(dict(id='court-lane', kind='concrete', w=7, osm=0, pts=LP([(98, -13), (60, -12.8), (40, -12.5), (24, -14.5)])))
# 言論廣場雕像後方步道：白色雨棚平台西緣 → 雕像北側林緣 → 戶外劇場南緣 → 通識東端階梯（13757/13762）
paths.append(dict(id='statue-back', kind='footway', w=2.6, osm=0, pts=LP([(-24, -48), (-34, -52), (-44, -51), (-53, -53), (-62, -54), (-66, -52)])))
paths.append(dict(id='she-court-steps', kind='steps', w=4.5, osm=0, pts=LP([(21.2, -18.5), (21.2, -30.5)])))
# ─── 補充周邊建物：國土測繪中心通用電子地圖建物塊（OSM 缺漏的街區） ─────────
# 空拍 0042/0045 顯示校區北、東、南側為密集 3–8 層民宅；OSM 只畫了一部分。
_road_lines = []
for wid, w in W.items():
    hw = w['tags'].get('highway')
    if not hw or hw in ('footway', 'steps', 'path', 'pedestrian', 'corridor'):
        continue
    try:
        lp = way_pts(wid)
    except Exception:
        continue
    if len(lp) >= 2:
        _road_lines.append(LineString(lp).buffer(3.0 if hw in ('residential', 'service', 'unclassified', 'living_street') else 4.5))
for p in paths:
    if len(p['pts']) >= 2:
        _road_lines.append(LineString(p['pts']).buffer(p['w'] / 2 + 0.6))
road_union = unary_union(_road_lines)
nb_union = unary_union([Polygon(n['poly']).buffer(0) for n in neighbors])
_emap_added = 0
for e in json.load(open(f'{GEO}/emap_buildings.json')):
    try:
        poly = Polygon(e['pts']).buffer(0).buffer(-0.5).simplify(0.6)
    except Exception:
        continue
    if poly.is_empty or poly.geom_type != 'Polygon' or poly.area < 15:
        continue
    c = poly.centroid
    if not (BOUNDS['x0'] - 60 < c.x < BOUNDS['x1'] + 40 and BOUNDS['y0'] - 40 < c.y < BOUNDS['y1'] + 40):
        continue
    if poly.intersection(campus_union.buffer(1.5)).area > 0.08 * poly.area:
        continue
    if poly.intersection(nb_union.buffer(1.0)).area > 0.15 * poly.area:
        continue
    poly = poly.difference(road_union)
    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    if poly.is_empty or poly.geom_type != 'Polygon' or poly.area < 15:
        continue
    hsh = (int(e['id']) * 2654435761) % 1000
    floors = (2 + hsh % 2) if poly.area < 70 else (4 + hsh % 3) if poly.area < 400 else (5 + hsh % 4)
    neighbors.append(dict(osm=-int(e['id']) - 1, floors=floors, poly=list(poly.exterior.coords)[:-1]))
    _emap_added += 1
print('emap neighbors added', _emap_added, file=sys.stderr)
# 舍我樓北／東北側（試院路一帶）OSM 與電子地圖都缺漏的民宅：依 NLSC 正射屋頂手描
# （north_gap.jpg，2026-10-04；0042_030 空拍確認為 4–7 層粉色／灰色公寓，頂樓多綠色鐵皮加蓋）
MANUAL_NB = [  # (x0, z0, x1, z1, 樓層)  場景座標 x 東、z 南
    (-20, -162, -6.5, -145.5, 5), (-12, -166, 0, -147, 4), (10, -160, 30, -145, 5),
    (41.5, -168, 58.5, -151, 6), (52, -150, 66, -133, 5), (67.7, -149, 75.4, -142, 4),
    (-40, -120.5, -21, -101.5, 3), (-20.5, -111.5, -12.5, -95, 3),
    (51, -110, 58.5, -89, 5), (60, -88.5, 68.5, -73, 4),
    (84.6, -148.5, 98.5, -124, 5), (101.5, -161, 113.8, -150, 4), (113.8, -158, 129, -145, 5),
    (118.5, -94.5, 129, -81, 4),
]
_nb_union = unary_union([Polygon(n['poly']).buffer(0) for n in neighbors])
_manual = 0
for i, (x0, z0, x1, z1, fl) in enumerate(MANUAL_NB):
    poly = Polygon(LP([(x0, z0), (x1, z0), (x1, z1), (x0, z1)]))
    poly = poly.difference(_nb_union).difference(road_union)
    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    if poly.is_empty or poly.area < 25:
        continue
    neighbors.append(dict(osm=-9000000 - i, floors=fl, poly=list(poly.exterior.coords)[:-1]))
    _manual += 1
print('manual neighbors added', _manual, file=sys.stderr)

# ─── 鋪面區域 ───────────────────────────────────────────
areas = []


def area(aid, kind, pts):
    areas.append(dict(id=aid, kind=kind, poly=pts))


area('speech', 'plaza', ring(245408150))  # 06 言論廣場
area('bafang', 'plaza', ring(245410246))  # 八方廣場
area('theatre', 'plaza', ring(245408151))  # 戶外劇場
# 14 學校廣場（航照判讀：舍我樓東側至大禮堂西牆，北接後校門）
# 舍我樓前庭（主塔南側、入口棟東側的粉紅鋪面，0045_069–074）與北側中庭（主塔西側、南翼北面退台前，0034_124）
area('she-court', 'plaza', LP([(12.5, -30.5), (12.5, -38), (16.5, -38), (16.5, -47.5), (36, -47.5), (37, -31)]))
# 言論廣場東北角～舍我樓 R 北側：白色張力膜雨棚＋木平台（使用者照片 13757/13762/13765），原為樹林
area('she-terrace', 'plaza', LP([(-46, -52), (-36, -52.5), (-13, -50), (-13, -40.5), (-31, -40.5), (-37, -33), (-41, -39), (-44, -45)]))
area('cafe-deck', 'plaza', LP([(44, -8.4), (78, -8.4), (78, 1.5), (44, 3.5)]))  # 0042_128 林緣咖啡座（不長樹）
area('she-yard', 'plaza', LP([(-13, -35), (2.5, -35), (2.5, -44), (-13, -44)]))  # 0038_053：西緣為棕櫚與樹林，再往西是下坡小徑
area('she-podium', 'plaza', LP([(-8, -44), (2.5, -44), (2.5, -47.6), (-1, -49.5), (-8, -47.5)]))  # 圓柱與弧形裙樓之間的灰綠磁磚平台  # 0042_030：南翼拱廊北面前的窄中庭，再往北即樹林
area('school-plaza', 'plaza', [(365.5, 196), (365.5, 229.5), (397, 229.5), (401, 240.5), (417, 241.5), (430, 241), (430, 228), (428, 226), (428.5, 190), (424.5, 181), (416, 166), (405, 176), (392, 186), (375, 192)])
# 大禮堂北側通道到操場（含兩段階梯）
area('aud-apron', 'grounds', [(430, 228), (430, 236), (472, 236), (476, 222), (472, 219), (471, 227), (430, 227)])
# 操場整體鋪面（含網球場、跑道、外圍）
area('sports', 'sports', [(471, 181), (472, 219), (497, 222), (571, 213), (580, 209), (578, 168), (548, 170), (547, 176), (482, 177)])
area('tennis', 'court', ring(245408166))
area('field', 'field', ring(245411855))
area('court-e', 'court', ring(245411856))
# 傳播大廈前（東側入口與南側車道）
area('c-forecourt', 'grounds', [(601, 158), (621, 165), (630, 176), (624, 190), (612, 200), (606, 196), (612, 186), (611, 166)])
# 前校門口（木柵路北側人行空間）
area('gate-front', 'grounds', [(78, 74), (100, 66), (104, 74), (97, 92), (84, 84)])
# 八風舞台周邊
area('stage-yard', 'grounds', [(405, 176), (416, 162), (428, 162), (429, 178), (424.5, 181), (416, 166)])
# 校舍周邊空地（建物外 3 公尺，限校內主要建物）
for bid in ('ADM', 'L', 'L1', 'G', 'B', 'T', 'D1', 'D2', 'D3', 'A', 'C', 'V', 'M', 'OM', 'J', 'W'):
    b = next(x for x in buildings if x['id'] == bid)
    ap = Polygon(b['poly']).buffer(3.0, join_style=2).simplify(0.5)
    area(f'apron-{bid}', 'apron', list(ap.exterior.coords)[:-1])

# ─── 自動導覽／主動線：前校門 → 傳播大廈 C 棟 ──────────────
ROUTE = [
    (89.0, 70.5),  # 木柵路人行道（校門口）
    (86.2, 80.4), (89.2, 86.1), (97.1, 93.5),  # 前校門 → 隧道口
    (151.7, 141.3),  # 隧道出口
    (157.8, 145.2), (202.0, 169.3), (218.8, 177.6),  # 出隧道道路（行政大樓南側）
    (233, 182.5), (251, 188), (270, 190), (286.7, 192.8), (292.9, 194.9),  # 八方廣場 → 舍我樓南側
    (367.4, 195.2), (390, 203), (412, 222), (433, 231.5),  # 學校廣場
    (468, 231.5), (474, 220), (495, 218), (501, 221), (504, 225),  # 大禮堂北側 → 操場北緣
    (540, 219), (570, 213), (586, 209), (595, 205), (598, 202), (606, 194), (615, 187), (619, 181), (614, 179.5),  # 傳播大廈東側入口
]

# ─── 高程控制點（公尺，近似；依電子地圖等高線與坡道 10%）──────
ELEV = [
    (60, 40, 11), (89, 70, 12), (120, 40, 11), (200, 20, 11), (330, -40, 12), (500, -75, 12), (650, -50, 12),  # 木柵路
    (97, 93, 12.5), (124, 117, 14), (151.7, 141.3, 16),  # 隧道
    (166, 156, 18), (182, 166, 20), (197, 177, 22), (213, 187, 23.8), (225, 198, 24.5),  # 坡道（使用者指正：行政大樓前為明顯斜坡）
    (250, 190, 24), (240, 205, 25), (262, 222, 26), (215, 225, 27), (210, 255, 28.5), (226, 287, 30),  # 八方／言論／圖書館（建於坡上，逐層升高）
    (190, 185, 21.5), (180, 165, 19), (190, 140, 18), (240, 160, 20), (275, 170, 20), (285, 135, 18), (272, 116, 17),  # 行政、宿舍、廣電
    (290, 194, 23.2), (300, 195, 22.8), (330, 195, 22.5), (360, 195, 22), (310, 220, 22.5), (350, 230, 22.5),  # 舍我樓
    (385, 205, 21.5), (410, 225, 21), (415, 241, 20.5), (420, 175, 21), (400, 185, 21.5),  # 學校廣場
    (450, 231, 20), (440, 195, 20), (472, 225, 18.5), (500, 200, 18), (540, 195, 18), (575, 190, 18),  # 大禮堂、操場
    (515, 160, 18), (595, 185, 18), (615, 180, 18), (625, 170, 17.5),  # 智能、傳播
    (500, 238, 19.5), (560, 228, 19), (600, 212, 18.5), (630, 177, 17), (642, 124, 15), (665, 48, 13), (690, -30, 12),  # 試院路（東側下坡）
    (436, 246, 20), (402, 242, 20), (380, 257, 21), (365, 320, 23),  # 試院路西段、154 巷
    (460, 147, 18), (420, 149, 18), (400, 124, 17), (514, 119, 16), (550, 105, 15), (570, 64, 14),  # 試院路南段
    (480, -28, 12.5), (500, -50, 12), (450, 40, 13), (380, 20, 13), (310, -30, 12),  # 管院、59 巷
    (55, 115, 13), (150, 80, 13), (40, 160, 14),  # 新聞、世界
    (430, 280, 22), (500, 265, 21), (620, 255, 19), (660, 140, 15), (700, 100, 14),  # 北側住宅區
]

# 山坡森林（不可步行，地形隨離步行區距離升高）
FOREST = [
    # 西側山（圖書館、行政以西，新聞大樓以北）
    [(-20, 125), (30, 122), (85, 132), (100, 100), (130, 118), (165, 128), (182, 112), (176, 100), (150, 88), (168, 84), (190, 104), (205, 150), (190, 172), (176, 196), (205, 245), (192, 272), (225, 292), (240, 300), (260, 296), (282, 262), (300, 250), (300, 335), (-20, 335)],
    # 南側山（廣電與學校廣場以南、59 巷以北）
    [(205, 108), (226, 140), (255, 152), (262, 160), (295, 152), (300, 188), (365, 190), (392, 182), (405, 172), (410, 158), (400, 128), (385, 92), (330, 72), (300, 60), (250, 45), (215, 60)],
]

out = dict(
    note='座標單位公尺；x 向東、z 向南。來源：OpenStreetMap 貢獻者（ODbL）、國土測繪中心正射影像判讀、世新大學官網樓層資訊。',
    origin=dict(lat=LAT0, lon=LON0, ox=OX, oy=OY),
    bounds=dict(minX=BOUNDS['x0'] - OX, maxX=BOUNDS['x1'] - OX, minZ=OY - BOUNDS['y1'], maxZ=OY - BOUNDS['y0']),
)


def S(p):
    return [round(p[0] - OX, 2), round(OY - p[1], 2)]


def SP(pts):
    return [S(p) for p in pts]


out['buildings'] = [dict(id=b['id'], num=b['num'], name=b['name'], code=b['code'], osm=b['osm'], floors=b['floors'], h=round(b['floors'] * FLOOR + 0.8, 1), style=b['style'], poly=SP(b['poly']),
                         **({'ground': [SP(g) for g in b['ground']], 'groundH': b['groundH']} if 'ground' in b else {})) for b in buildings]
# 學校廣場西南、林緣的露天咖啡座（0042_128：深色四坡頂小亭＋木平台＋陽傘），電子地圖誤畫為 3 層樓量體，改由 world.ts 建小亭
def _in_cafe(n):
    pts = SP(n['poly'])
    cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
    return 40 < cx < 80 and -9 < cz < 4
neighbors = [n for n in neighbors if not _in_cafe(n)]
out['neighbors'] = [dict(osm=n['osm'], h=round(n['floors'] * 3.2, 1), poly=SP(n['poly'])) for n in neighbors]
out['paths'] = [dict(id=p['id'], kind=p['kind'], w=p['w'], osm=p['osm'], pts=SP(p['pts'])) for p in paths]
out['areas'] = [dict(id=a['id'], kind=a['kind'], poly=SP(a['poly'])) for a in areas]
out['route'] = SP(ROUTE)
out['elev'] = [S(p[:2]) + [p[2]] for p in ELEV]
out['forest'] = [SP(fp) for fp in FOREST]
# 操場跑道：依 OSM 球場長邊方向（約東偏南 8.5°）與航照外緣
fld = ring(245411855)
ang = math.atan2(fld[2][1] - fld[1][1], fld[2][0] - fld[1][0])  # 本地座標下長邊方向
out['track'] = dict(center=S((536, 194)), rot=round(ang, 4), len=84, w=40, lane=6)
# 八風舞台（OSM amenity=shelter 493929425）
st = Polygon(ring(493929425))
out['stage'] = dict(center=S((st.centroid.x, st.centroid.y)), r=round(math.sqrt(st.area / math.pi), 2))
# 後校門（學校廣場北端步道接試院路處）、前校門（隧道西南口）
# 0052_059 正射對位：後校門開在學校廣場北緣圍欄上（backgate-walk 步道穿過處），不在試院路路口中央
out['backGate'] = dict(center=S((414.2, 235.4)), dir=[5.0, -15.0])
out['frontGate'] = dict(center=S((97.1, 93.5)), dir=[round(151.7 - 97.1, 2), round(-(141.3 - 93.5), 2)])

json.dump(out, open(f'{GEO}/site.json', 'w'), ensure_ascii=False)
ts = '/* 由 /home/ubuntu/geo/build_site.py 產生，請勿手動修改。 */\n'
ts += 'import type { SiteData } from \'./siteTypes\'\n'
ts += 'export const SITE: SiteData = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n'
open('/home/ubuntu/shucampus/src/campus/site.ts', 'w').write(ts)
print('buildings', len(out['buildings']), 'neighbors', len(out['neighbors']), 'paths', len(out['paths']), 'areas', len(out['areas']))

# ─── 驗證圖 ─────────────────────────────────────────────
if '--check' in sys.argv:
    from PIL import Image, ImageDraw, ImageFont
    z, tx0, ty0 = f['z'], f['tx0'], f['ty0']

    def px(p):
        lat = LAT0 + p[1] / 110574
        lon = LON0 + p[0] / K
        n = 2 ** z * 256
        return ((lon + 180) / 360 * n - tx0 * 256, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n - ty0 * 256)

    im = Image.open(f'{GEO}/ortho_nlsc_19.jpg').convert('RGB')
    dr = ImageDraw.Draw(im, 'RGBA')
    font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 22) if __import__('os').path.exists('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc') else ImageFont.load_default()
    for fp in FOREST:
        dr.polygon([px(p) for p in fp], outline=(120, 255, 120, 255), fill=(0, 255, 0, 30))
    for a in areas:
        col = {'plaza': (255, 170, 60), 'sports': (255, 60, 60), 'court': (60, 120, 255), 'field': (60, 220, 60), 'grounds': (255, 230, 120), 'apron': (200, 200, 200)}[a['kind']]
        if a['kind'] == 'apron':
            continue
        dr.polygon([px(p) for p in a['poly']], outline=col + (255,), fill=col + (50,))
    for p in paths:
        col = {'road': (255, 255, 255), 'lane': (255, 220, 0), 'footway': (0, 200, 255), 'steps': (255, 0, 255), 'covered': (0, 255, 160), 'tunnel': (255, 120, 0)}[p['kind']]
        dr.line([px(q) for q in p['pts']], fill=col + (230,), width=max(2, int(p['w'] / 0.2706 * 0.5)))
    for n in neighbors:
        dr.polygon([px(p) for p in n['poly']], outline=(150, 150, 150, 255))
    for b in buildings:
        q = [px(p) for p in b['poly']]
        dr.polygon(q, outline=(255, 30, 30, 255), fill=(255, 0, 0, 40))
        dr.line(q + [q[0]], fill=(255, 30, 30, 255), width=3)
    for b in buildings:
        c = Polygon(b['poly']).centroid
        cx, cy = px((c.x, c.y))
        dr.text((cx - 20, cy - 12), (b['num'] + ' ' if b['num'] else '') + b['name'], fill=(255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
    dr.line([px(p) for p in ROUTE], fill=(255, 0, 120, 255), width=5)
    for gx in range(0, 721, 50):
        dr.line([px((gx, -105)), px((gx, 335))], fill=(255, 255, 255, 70), width=1)
        dr.text(px((gx + 1, 333)), str(gx), fill=(255, 255, 255), font=font)
    for gy in range(-100, 336, 50):
        dr.line([px((-20, gy)), px((720, gy))], fill=(255, 255, 255, 70), width=1)
        dr.text(px((-18, gy + 4)), str(gy), fill=(255, 255, 255), font=font)

    def crop(name, x0, x1, y0, y1, s):
        a, b_ = px((x0, y1)), px((x1, y0))
        c = im.crop((int(a[0]), int(a[1]), int(b_[0]), int(b_[1])))
        c = c.resize((int(c.width * s), int(c.height * s)))
        c.save(f'{GEO}/site_check_{name}.jpg', quality=86)
    crop('all', -20, 720, -105, 335, 0.42)
    crop('west', 20, 310, 60, 310, 0.8)
    crop('east', 290, 660, 110, 270, 0.8)
    crop('south', 380, 720, -105, 130, 0.6)
