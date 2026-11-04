"""Rendered cloth regression: real drag, visible garment pixels, unchanged skin."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright
HERE=Path(__file__).resolve().parent

def main():
    with tempfile.TemporaryDirectory(prefix='hq-cloth-visible-') as root:
        proc=subprocess.Popen([sys.executable,str(HERE/'carnet_test_server.py'),root],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            info=json.loads(proc.stdout.readline().decode())
            with sync_playwright() as p:
                browser=p.chromium.launch()
                for label,width in [('desktop',1440),('phone',390)]:
                    ctx=browser.new_context(viewport={'width':width,'height':1000 if width>400 else 844},reduced_motion='reduce')
                    ctx.add_init_script("localStorage.setItem('hq_companion_collapsed','0');localStorage.setItem('hq_companion_nsfw','1');localStorage.setItem('hq_companion_layered_portrait','1')")
                    page=ctx.new_page();errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    def fake(route,request):
                        if request.method=='GET':return route.fulfill(json={'ok':True,'configured':True,'companion_cap':'flirt','nsfw_allowed':True,'session_admin':True,'messages':[]})
                        return route.fulfill(json={'ok':True,'messages':[],'line':''})
                    page.route('**/api/ai**',fake)
                    page.goto(info['base']);page.locator('input[name="pin"]').fill(info['admin_pin']);page.locator('button[type="submit"]').click()
                    page.wait_for_selector('.has-layered-portrait');page.wait_for_timeout(350)
                    page.add_style_tag(content='.hq-companion *{animation:none!important;transition:none!important}.hq-companion-frame{visibility:hidden!important}')
                    avatar=page.locator('.hq-companion-avatar');box=avatar.bounding_box()
                    x=box['x']+box['width']*.35;y=box['y']+box['height']*.72
                    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-30,y-30,steps=8);page.wait_for_timeout(350)
                    assert page.locator('#hq-companion').evaluate('(e)=>e.classList.contains("is-bust-pull")')
                    assert page.locator('.hq-companion-rig-cloth').evaluate_all('(els)=>els.some(e=>Number(e.dataset.tension)>.15)')
                    transform=page.locator('.hq-companion-rig-cloth image').first.get_attribute('transform')
                    assert transform and 'scale(1.0000 1.0000)' not in transform
                    on=HERE.parent/'artifacts'/('cloth-visible-'+label+'.png')
                    off=HERE.parent/'artifacts'/('cloth-hidden-'+label+'.png')
                    avatar.screenshot(path=str(on))
                    texture_file=HERE.parent/'artifacts'/('cloth-texture-only-'+label+'.png')
                    paths=page.add_style_tag(content='.hq-companion-rig-cloth > path{visibility:hidden!important}')
                    avatar.screenshot(path=str(texture_file))
                    paths.evaluate('(e)=>e.remove()')
                    style=page.add_style_tag(content='.hq-companion-rig-cloth{visibility:hidden!important}')
                    avatar.screenshot(path=str(off))
                    a=Image.open(on).convert('RGB');b=Image.open(off).convert('RGB');d=ImageChops.difference(a,b)
                    w,h=a.size;lower=d.crop((0,int(h*.48),w,h))
                    visible=sum(max(pixel)>20 for pixel in lower.get_flattened_data())
                    assert visible>(150 if width>400 else 60),(label,visible,d.getbbox())
                    texture_diff=ImageChops.difference(Image.open(texture_file).convert('RGB'),b)
                    texture_pixels=sum(max(pixel)>12 for pixel in texture_diff.get_flattened_data())
                    assert texture_pixels>(40 if width>400 else 15),('actual cloth texture did not deform',label,texture_pixels)

                    assert d.crop((0,0,w,int(h*.43))).getbbox() is None,'cloth effect reached face/upper skin'
                    style.evaluate('(e)=>e.remove()');page.mouse.up();page.wait_for_timeout(400)
                    assert page.locator('.hq-companion-rig-cloth').evaluate_all('(els)=>els.every(e=>Number(e.dataset.tension)<.03)'),'cloth failed to relax'
                    assert not errors,errors
                    print(label+': visible cloth texture/folds ('+str(visible)+' pixels; texture '+str(texture_pixels)+'), skin exclusion and release passed',flush=True)
                    ctx.close()
                browser.close()
        finally:
            proc.terminate();proc.wait(timeout=10)
if __name__=='__main__':main()
