# Renders saved grown plates through the page's own shader (headless Chrome), no sound running.
# python3 tools/figure.py SEED  -> results/plates_SEED.png
import asyncio, json, sys, io
from playwright.async_api import async_playwright
from PIL import Image
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 2718
grown = json.load(open(f'results/grown_{seed}.json'))
names = ['original', 'low', 'high', 'keyC', 'keyFs']
async def main():
  async with async_playwright() as p:
    b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    pg = await b.new_page(viewport={'width': 1500, 'height': 900})
    await pg.goto(f'file:///home/claude/resonatingmatter/index.html?seed={seed}'); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('begin').remove();document.querySelector('.title').style.display='none';document.getElementById('readout').style.display='none'")
    tiles = []
    for n in names:
      if n == 'original': await pg.evaluate(f"window.__rm.send({{t:'reseed',seed:{seed}}})")
      else:
        g = grown[n]
        await pg.evaluate("g=>{const b=new RM.Body(%d);window.__rm.send({t:'set',m:{v:1,seed:%d,sand:Float32Array.from(g.sand),gx:Float32Array.from(g.gx),gy:Float32Array.from(g.gy),driver:b.driver,pick:b.pick}})}" % (seed, seed), g)
      await pg.wait_for_timeout(400)
      x, y, s = await pg.evaluate("window.__rm.plate")
      shot = await pg.screenshot(clip={'x': x, 'y': y, 'width': s, 'height': s})
      tiles.append(Image.open(io.BytesIO(shot)).convert('RGB').resize((360, 360)))
    await b.close()
  out = tiles
  W = Image.new('RGB', (360 * len(out) + 10 * (len(out) - 1), 360), (12, 18, 20))
  for i, o in enumerate(out): W.paste(o, (i * 370, 0))
  W.save(f'results/plates_{seed}.png'); print('saved', W.size)
asyncio.run(main())
