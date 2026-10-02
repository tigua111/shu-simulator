import json, math, numpy as np, cv2
from PIL import Image
f=json.load(open('frame.json')); z=f['z']; LAT0=f['LAT0']; LON0=f['LON0']
K=111320*math.cos(math.radians(LAT0)); OX,OY=330.0,180.0
site=json.load(open('site.json')); B=site['bounds']
im=np.asarray(Image.open('ortho_nlsc_19.jpg').convert('RGB')).astype(np.float32)
H,W=im.shape[:2]
im=cv2.GaussianBlur(im,(0,0),3)
r,g,b=im[...,0],im[...,1],im[...,2]
exg=2*g-r-b
veg=((exg>6)&(g-b>=-1)&(g<150))|((r+g+b)<165)
veg=veg.astype(np.uint8)*255
veg=cv2.morphologyEx(veg,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
veg=cv2.morphologyEx(veg,cv2.MORPH_CLOSE,np.ones((9,9),np.uint8))
n=2**z
def px(lon,lat):
    X=(lon+180)/360*n*256
    s=math.sin(math.radians(lat))
    Y=(0.5-math.log((1+s)/(1-s))/(4*math.pi))*n*256
    return X-f['tx0']*256, Y-f['ty0']*256
G=2.0
nx=int((B['maxX']-B['minX'])/G)+1; nz=int((B['maxZ']-B['minZ'])/G)+1
mask=np.zeros((nz,nx),np.uint8)
for j in range(nz):
    for i in range(nx):
        sx=B['minX']+i*G; sz=B['minZ']+j*G
        x=sx+OX; y=OY-sz
        lon=LON0+x/K; lat=LAT0+y/110574
        u,v=px(lon,lat)
        if 0<=u<W and 0<=v<H: mask[j,i]=1 if veg[int(v),int(u)] else 0
# 去除孤立小點
num,lab,st,_=cv2.connectedComponentsWithStats(mask,8)
for k in range(1,num):
    if st[k,cv2.CC_STAT_AREA]<4: mask[lab==k]=0
print('grid',nx,nz,'cover',mask.mean().round(3))
np.save('canopy.npy',mask)
json.dump(dict(minX=B['minX'],minZ=B['minZ'],step=G,nx=nx,nz=nz),open('canopy_meta.json','w'))
# 檢查圖：遮罩疊航照（縮小）
vis=cv2.resize(mask*255,(nx*3,nz*3),interpolation=cv2.INTER_NEAREST)
Image.fromarray(vis).save('canopy_mask.png')
# 陰影暗色只在山坡（FOREST 多邊形）內才算樹林；山坡外只保留綠色判讀
from matplotlib.path import Path
im2=np.asarray(Image.open('ortho_nlsc_19.jpg').convert('RGB')).astype(np.float32)
im2=cv2.GaussianBlur(im2,(0,0),3)
r2,g2,b2=im2[...,0],im2[...,1],im2[...,2]
green=(((2*g2-r2-b2)>6)&(g2-b2>=-1)&(g2<150)).astype(np.uint8)*255
green=cv2.morphologyEx(green,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
polys=[Path(np.array(fp)) for fp in site['forest']]
out=np.zeros_like(mask)
for j in range(nz):
    for i in range(nx):
        sx=B['minX']+i*G; sz=B['minZ']+j*G
        inF=any(p.contains_point((sx,sz)) for p in polys)
        if inF: out[j,i]=mask[j,i]
        else:
            x=sx+OX; y=OY-sz; u,v=px(LON0+x/K, LAT0+y/110574)
            if 0<=u<W and 0<=v<H and green[int(v),int(u)]: out[j,i]=1
out=cv2.morphologyEx(out,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
mask=out
print('final cover',mask.mean().round(3))
np.save('canopy.npy',mask)
import base64
bits=np.packbits(mask.reshape(-1))
b64=base64.b64encode(bits.tobytes()).decode()
open('/home/ubuntu/shucampus/src/campus/canopy.ts','w').write(
"/** 由 tools/canopy.py 依國土測繪中心正射影像（NLSC 2024）判讀的樹冠遮罩。2 公尺格網、逐列位元打包（base64）。 */\n"
f"export const CANOPY = {{ minX: {B['minX']}, minZ: {B['minZ']}, step: {G}, nx: {nx}, nz: {nz}, bits: '{b64}' }}\n")
vis=cv2.resize(mask*255,(nx*3,nz*3),interpolation=cv2.INTER_NEAREST)
Image.fromarray(vis).save('canopy_mask.png')
