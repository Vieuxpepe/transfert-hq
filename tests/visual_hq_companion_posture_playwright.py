"""Isolated UI regression for posture persistence, cloth load and scoped variables."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
HERE = Path(__file__).resolve().parent

def main():
    with tempfile.TemporaryDirectory(prefix='hq-posture-') as root:
        proc = subprocess.Popen([sys.executable,str(HERE/'carnet_test_server.py'),root],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            info = json.loads(proc.stdout.readline().decode())
            with sync_playwright() as p:
                browser = p.chromium.launch()
                for label,width,reduced in [('desktop',1440,False),('phone',390,False),('reduced',390,True)]:
                    ctx = browser.new_context(viewport={'width':width,'height':1000 if width>400 else 844},reduced_motion='reduce' if reduced else 'no-preference')
                    ctx.add_init_script("localStorage.setItem('hq_companion_collapsed','0');localStorage.setItem('hq_companion_nsfw','1');localStorage.setItem('hq_companion_layered_portrait','1')")
                    page = ctx.new_page(); page.set_default_timeout(15000); errors=[]
                    page.on('pageerror',lambda e: errors.append(str(e)))
                    def fake(route,request):
                        if request.method=='GET':return route.fulfill(json={'ok':True,'configured':True,'companion_cap':'flirt','nsfw_allowed':True,'session_admin':True,'messages':[]})
                        return route.fulfill(json={'ok':True,'messages':[],'line':''})
                    page.route('**/api/ai**',fake)
                    page.goto(info['base']);page.locator('input[name="pin"]').fill(info['admin_pin']);page.locator('button[type="submit"]').click()
                    page.wait_for_selector('.has-layered-portrait')
                    page.add_style_tag(content='.hq-companion-bubble{animation:none!important}')
                    print(label+': opening controls',flush=True)
                    page.locator('.hq-companion-fx-menu-toggle').click()
                    page.wait_for_timeout(400)  # Existing phone sheet entry transition.
                    page.locator('.hq-companion-fx-debug').get_by_text('Réglages',exact=True).click()
                    select = page.get_by_label('Posture du portrait')
                    print(label+': changing posture',flush=True)
                    select.select_option('left');page.wait_for_timeout(900)
                    body=page.locator('.hq-companion-rig-body')
                    rotation=body.evaluate('(e)=>getComputedStyle(e).rotate')
                    assert rotation!='none' and not rotation.endswith(' 0deg'),rotation
                    counter=page.locator('.hq-companion-frame.is-in-rig').evaluate('(e)=>getComputedStyle(e).rotate')
                    assert counter!='none' and not counter.endswith(' 0deg'),counter
                    assert page.evaluate("""() => {
                      function rotation(selector) {
                        const v=getComputedStyle(document.querySelector(selector)).rotate.trim().split(/\s+/);
                        if(v.length===1)return new DOMMatrix().rotate(0,0,parseFloat(v[0])||0);
                        if(v.length===2){const a={x:[1,0,0],y:[0,1,0],z:[0,0,1]}[v[0]];return new DOMMatrix().rotateAxisAngle(...a,parseFloat(v[1]));}
                        return new DOMMatrix().rotateAxisAngle(Number(v[0]),Number(v[1]),Number(v[2]),parseFloat(v[3]));
                      }
                      const m=rotation('.hq-companion-rig-body').multiply(rotation('.hq-companion-frame.is-in-rig'));
                      return Math.abs(m.m11-1)+Math.abs(m.m22-1)+Math.abs(m.m33-1)+Math.abs(m.m12)+Math.abs(m.m13)+Math.abs(m.m23)<.00001;
                    }""")

                    assert page.evaluate("localStorage.getItem('hq_companion_posture_v1')")=='left'
                    checkbox=page.get_by_label('Tension du tissu',exact=True)
                    checkbox.uncheck();page.wait_for_timeout(100)
                    assert page.locator('.hq-companion-rig-cloth').evaluate_all('(els)=>els.every(e=>Number(e.style.opacity)===0)')
                    checkbox.check()
                    # Use the sheet's own close control on phone as well as desktop.
                    page.get_by_role('button',name='Fermer les outils',exact=True).click()
                    box=page.locator('.hq-companion-avatar').bounding_box();x=box['x']+box['width']*.35;y=box['y']+box['height']*.72
                    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-26,y-28,steps=8)
                    assert page.locator('#hq-companion').evaluate('(e)=>e.classList.contains("is-bust-pull")')
                    frozen=body.evaluate('(e)=>getComputedStyle(e).rotate')
                    select.evaluate('(e)=>{e.value="forward";e.dispatchEvent(new Event("change",{bubbles:true}))}')
                    page.wait_for_timeout(100)
                    assert body.evaluate('(e)=>getComputedStyle(e).rotate')==frozen,'posture changed during pull'
                    assert page.locator('.hq-companion-rig-cloth').evaluate_all('(els)=>els.some(e=>Number(e.dataset.tension)>.1)'), 'fabric did not tighten'
                    page.screenshot(path=str(HERE.parent/'artifacts'/('companion-cloth-'+label+'.png')))
                    page.mouse.up();page.wait_for_timeout(1500)
                    assert body.evaluate('(e)=>getComputedStyle(e).rotate')!=frozen,'queued posture did not apply after release'
                    assert page.locator('#hq-companion').evaluate('(e)=>Array.from(e.style).filter(k=>k.startsWith("--rig-posture-")).length')==0,'posture vars leaked to root'
                    assert page.locator('.hq-companion-rig-cloth').count()==2
                    assert page.locator('.hq-companion-rig-cloth').evaluate_all("""els=>els.every(e=>{
                      const side=e.classList.contains('is-left')?'left':'right';
                      const image=e.parentElement.querySelector('img.hq-companion-rig-bust-'+side);
                      const a=getComputedStyle(e),b=getComputedStyle(image);
                      return a.transform===b.transform && a.transformOrigin===b.transformOrigin;
                    })"""),'fabric/cup transforms diverged'

                    page.reload()
                    page.wait_for_selector('.has-layered-portrait')
                    assert page.get_by_label('Posture du portrait').input_value()=='forward','posture did not survive reload'
                    assert page.get_by_label('Tension du tissu',exact=True).is_checked()
                    assert not errors,errors
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    print(label+': posture, persistence, cloth toggle/load, pull freeze/release, scoped variables passed',flush=True)
                    ctx.close()
                browser.close()
        finally:
            proc.terminate();proc.wait(timeout=10)
if __name__=='__main__':main()
