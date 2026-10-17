const s=require('./net/providers/steamrip');
(async()=>{
  const html=await s.fetchText('https://steamrip.com/');
  const re=/<a[^>]+href\s*=\s*"(\/?[^"]*free-download[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const m=re.exec(html);
  const pos=m.index;
  const lookback=html.slice(Math.max(0,pos-700),pos);
  console.log('lookback has data-back-webp:', lookback.includes('data-back-webp'));
  const reImg=/data-back-webp\s*=\s*"([^"]+)"/gi;
  const im=reImg.exec(lookback);
  console.log('img match:', im && im[1]);
})();
