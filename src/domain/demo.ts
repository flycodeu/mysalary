import type { OcrResult } from './types';

/** Synthetic fixture. These boxes are authored, not produced by an OCR engine. */
const rows: ReadonlyArray<readonly [string, string]> = [
  ['应发工资', '14138.2'],
  ['实发工资', '12145.82'],
  ['岗位（基本）薪水', '7000'],
  ['工龄津贴', '250'],
  ['高温津贴', '160'],
  ['补发合计', '-204.8'],
  ['月度奖惩', '3133'],
  ['奖金合计', '3133'],
  ['信息工程类嘉奖', '3800'],
  ['嘉奖合计', '3800'],
  ['养老保险费', '701.84'],
  ['失业保险费', '43.87'],
  ['医疗保险费', '175.46'],
  ['公积金', '439'],
  ['养老金补扣', '305.68'],
  ['医疗保险补扣', '76.42'],
  ['失业保险补扣', '19.11'],
  ['社保津贴补差', '-204.8'],
  ['个得税（计算）', '221'],
];

export const demoOcr: OcrResult = {
  engine: 'synthetic',
  modelVersion: 'fixture-v1',
  elapsedMs: 0,
  imageWidth: 390,
  imageHeight: 1160,
  lines: [
    { text: '2026 年 09 月', box: { x: 128, y: 78, width: 140, height: 24 } },
    ...rows.flatMap(([label, amount], index) => [
      { text: `${label}：`, box: { x: 22, y: 128 + index * 49, width: 195, height: 22 } },
      { text: amount, box: { x: 270, y: 128 + index * 49, width: 98, height: 22 } },
    ]),
    { text: '2026 年 08 月', box: { x: 128, y: 1090, width: 140, height: 24 } },
  ],
};

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="1160" viewBox="0 0 390 1160">
<rect width="390" height="1160" fill="#fafaf7"/>
<rect width="390" height="62" fill="#173d38"/>
<text x="22" y="39" font-family="sans-serif" font-size="20" font-weight="700" fill="#fff">工资样例 · 合成数据</text>
<text x="195" y="99" text-anchor="middle" font-family="sans-serif" font-size="19" fill="#243e38">2026 年 09 月</text>
${rows.map(([label, amount], index) => {
  const y = 147 + index * 49;
  return `<text x="22" y="${y}" font-family="sans-serif" font-size="16" fill="#243e38">${escapeXml(label)}</text>
<text x="368" y="${y}" text-anchor="end" font-family="sans-serif" font-size="17" fill="#243e38">${amount}</text>
<path d="M22 ${y + 16}H368" stroke="#e5e9e2"/>`;
}).join('\n')}
<rect x="0" y="1070" width="390" height="70" fill="#e9eee7"/>
<text x="195" y="1111" text-anchor="middle" font-family="sans-serif" font-size="19" fill="#243e38">2026 年 08 月</text>
</svg>`;

export const demoImageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
