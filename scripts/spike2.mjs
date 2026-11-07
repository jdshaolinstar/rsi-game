import { generateImage, vision } from '../agent/meta.mjs';
import { writeFileSync } from 'node:fs';
let t = Date.now();
try {
  const img = await generateImage('Top-down view of a tiny dungeon room for a mobile arcade game, flat vector style, dark purple stone floor, glowing teal walls, bright orange hero circle, green slime enemies, gold coins, high contrast, no text');
  console.log('image ok', Date.now() - t, 'ms', img.slice(0, 60), img.length);
  if (img.startsWith('data:')) writeFileSync('public/target.png', Buffer.from(img.split(',')[1], 'base64'));
  t = Date.now();
  const v = await vision('Describe the dominant colors of this image as JSON {"floor":"#hex","wall":"#hex","accent":"#hex"}', [img]);
  console.log('vision ok', Date.now() - t, 'ms', JSON.stringify(v));
} catch (e) { console.log('ERR', Date.now() - t, e.message); }
