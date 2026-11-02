import { chromium } from '/tmp/vm-pr29/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const w of [320, 800]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } });
  await pg.goto('http://localhost:8162/', { waitUntil: 'networkidle' });
  await pg.evaluate(() => document.querySelector('#how')?.scrollIntoView());
  await pg.waitForTimeout(2600);
  const m = await pg.evaluate(() => {
    const how = document.querySelector('#how');
    const flow = how.querySelector('.pipe.flow2');
    const fr = flow.getBoundingClientRect();
    const liRights = [...flow.querySelectorAll('li')].map(li => +li.getBoundingClientRect().right.toFixed(1));
    const mark = flow.querySelector('.pf-hit mark')?.getBoundingClientRect();
    const li3 = flow.querySelectorAll('li')[2]?.getBoundingClientRect();
    return {
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      flowRight: +fr.right.toFixed(1), innerWidth,
      liPastFlow: liRights.map(r => +(r - fr.right).toFixed(1)),
      markPastLi: mark && li3 ? +(mark.right - li3.right).toFixed(1) : null,
      marker: !!flow.querySelector('.flow-marker'), rail: !!flow.querySelector('.flow-rail'),
      wire: !!how.querySelector('.pipe-wire')
    };
  });
  console.log(w, JSON.stringify(m));
  await pg.locator('#how').screenshot({ path: `/tmp/how-r2-${w}.png` });
  await pg.close();
}
await b.close();
