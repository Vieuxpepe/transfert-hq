"""Isolated long-reply reading regression; no live conversations or provider calls."""
import json, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
HERE = Path(__file__).resolve().parent
LONG = 'A complete thought with a useful detail. ' * 55 + 'TAIL PRESERVED.'
def main():
 with tempfile.TemporaryDirectory(prefix='hq-reading-') as root:
  proc = subprocess.Popen([sys.executable,str(HERE/'carnet_test_server.py'),root],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  try:
   info=json.loads(proc.stdout.readline().decode())
   with sync_playwright() as p:
    browser=p.chromium.launch()
    for width in (1440,390):
     ctx=browser.new_context(viewport={'width':width,'height':844},reduced_motion='reduce')
     ctx.add_init_script("localStorage.setItem('hq_companion_collapsed','0')")
     page=ctx.new_page(); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
     messages=[{'role':'assistant','text':LONG,'kind':'chat'}]
     def handle(route,request):
      if request.method=='GET':return route.fulfill(json={'ok':True,'configured':True,'companion_cap':'warm','messages':messages})
      body=json.loads(request.post_data or '{}')
      if body.get('op')=='send':
       messages.extend([{'role':'user','text':body['message'],'kind':'chat'},{'role':'assistant','text':LONG,'kind':'chat'}])
       return route.fulfill(json={'ok':True,'reply':LONG,'messages':messages})
      if body.get('action')=='ambient':return route.fulfill(json={'ok':True,'line':LONG})
      return route.fulfill(json={'ok':True,'messages':messages,'prefs':{}})
     page.route('**/api/ai**',handle)
     page.goto(info['base']);page.locator('input[name="pin"]').fill(info['admin_pin']);page.locator('button[type="submit"]').click()
     page.locator('.hq-companion-read-more').wait_for(state='visible')
     page.locator('.hq-companion-read-more').click()
     page.wait_for_timeout(400)
     assert page.locator('.hq-companion-msg-text').first.text_content()==LONG
     box=page.locator('.hq-companion-bubble').bounding_box()
     assert page.locator('.hq-companion-bubble').evaluate('(e)=>getComputedStyle(e).display')=='flex'
     assert page.locator('.hq-companion-actions').evaluate('(e)=>e.getBoundingClientRect().bottom<=e.closest(".hq-companion-bubble").getBoundingClientRect().bottom')
     assert box['y']>=0 and box['y']+box['height']<=845,box
     assert page.locator('.hq-companion-head').evaluate('(e)=>{const r=e.getBoundingClientRect(); return document.elementFromPoint(r.left+4,r.top+4)?.closest(".hq-companion-bubble")!==null}')
     page.locator('.hq-companion-log').evaluate('(e)=>e.scrollTop=0')
     page.locator('.hq-companion-input').fill('Another detail')
     page.locator('.hq-companion-send').click();page.wait_for_timeout(400)
     assert page.locator('.hq-companion-log').evaluate('(e)=>e.scrollTop')<5
     page.locator('.hq-companion-new-message').wait_for(state='visible')
     page.locator('.hq-companion-new-message').click()
     assert page.locator('.hq-companion-log').evaluate('(e)=>e.scrollHeight-e.clientHeight-e.scrollTop')<4
     assert page.locator('.hq-companion-msg-text').last.evaluate('(e)=>getComputedStyle(e).userSelect')=='text'
     assert not errors,errors
     page.screenshot(path=str(HERE.parent/'artifacts'/f'companion-reading-{width}.png'))
     print(f'{width}: full text, preview, viewport fit, reader position, new-message action and selection passed',flush=True)
     ctx.close()
    browser.close()
  finally:proc.terminate();proc.wait(timeout=10)
if __name__=='__main__':main()
