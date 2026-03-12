// ═══════════════════════════════════════════════════════════
//  СораАтлас v1.5
//  + Умный компактный инжект (локация + жилище + инструкция)
//  + Авто-трекинг движения персонажей из текста AI
//  + Поиск персонажей в карточке при генерации
//  + Хуки на события чата
// ═══════════════════════════════════════════════════════════

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

const EXT_NAME = 'sora_atlas';
const DEFAULT_SYSTEM_PROMPT = `You are a world-building assistant for interactive roleplay. Create immersive, sensory-rich locations that feel alive and grounded in the character's world. Each location should have distinct mood, texture, and purpose. Connect locations logically. Return ONLY valid JSON with no markdown fences, no explanation.`;

// ══════════════════════════════════════════════════════════
//  НАСТРОЙКИ
// ══════════════════════════════════════════════════════════

const DEFAULT_SETTINGS = {
  enabled: true,
  api_key: '',
  api_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  lang: 'ru',
  autoWallpaper: false,
  autoTrackMovement: true,
  injectHome: true,
  contextMessages: 15,
  worlds: {},
  gen: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    includeCard: true,
    includeLorebook: true,
    locationCount: '4-7',
    includeUser: true,
    generateNpcs: true,
    npcCount: 3,
    userWish: '',
  },
};

function getSettings() {
  extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (extension_settings[EXT_NAME][k] === undefined)
      extension_settings[EXT_NAME][k] = (typeof v === 'object' && !Array.isArray(v)) ? { ...v } : v;
  }
  const gen = extension_settings[EXT_NAME].gen;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.gen)) {
    if (gen[k] === undefined) gen[k] = v;
  }
  return extension_settings[EXT_NAME];
}

function saveSetting(key, value) { extension_settings[EXT_NAME][key] = value; saveSettingsDebounced(); }
function saveGenSetting(key, value) { extension_settings[EXT_NAME].gen[key] = value; saveSettingsDebounced(); }

// ══════════════════════════════════════════════════════════
//  ДАННЫЕ
// ══════════════════════════════════════════════════════════

function getCtx() {
  try { if (window.SillyTavern?.getContext) return window.SillyTavern.getContext(); } catch {}
  return { chatId: null, characterId: null, characters: [], name1: 'Пользователь', name2: '' };
}
function getChatId() {
  try { const c = getCtx(); return String(c.chatId || c.characterId || 'default'); } catch { return 'default'; }
}
function getUserName() { return getCtx().name1 || 'Пользователь'; }

function getWorld() {
  const s = getSettings(), id = getChatId();
  if (!s.worlds[id]) s.worlds[id] = { locations: [], characters: [], currentLocationId: null, worldDescription: '' };
  return migrateWorld(s.worlds[id]);
}

function migrateWorld(w) {
  if (!w.characters && w.characterLocations) {
    w.characters = Object.entries(w.characterLocations).map(([name, locId]) => ({
      id: `ch_${name.replace(/\s/g,'_')}`, name, icon: '🧑', type: 'main', locationId: locId, color: '#7bbde8',
    }));
    w.characters.unshift({ id:'u_user', name:'{{user}}', icon:'🧑', type:'user', locationId: w.currentLocationId||null, color:'#a78bfa' });
    delete w.characterLocations;
  }
  if (!w.characters) w.characters = [{ id:'u_user', name:'{{user}}', icon:'🧑', type:'user', locationId:null, color:'#a78bfa' }];
  return w;
}

function saveWorld(world) { getSettings().worlds[getChatId()] = world; saveSettingsDebounced(); }

// ══════════════════════════════════════════════════════════
//  ОБОИ ST
// ══════════════════════════════════════════════════════════

let _origBg = null;

function applyWallpaper(imageData) {
  const bg1 = document.getElementById('bg1');
  if (!bg1) return;
  if (_origBg === null) _origBg = bg1.style.backgroundImage || '';
  bg1.style.backgroundImage = `url(${imageData})`;
  bg1.style.backgroundSize = 'cover';
  bg1.style.backgroundPosition = 'center';
}

function restoreWallpaper() {
  const bg1 = document.getElementById('bg1');
  if (!bg1 || _origBg === null) return;
  bg1.style.backgroundImage = _origBg;
}

function applyLocationWallpaper(world) {
  if (!getSettings().autoWallpaper) return;
  const loc = world?.locations?.find(l => l.id === world.currentLocationId);
  if (loc?.image) applyWallpaper(loc.image);
}

// ══════════════════════════════════════════════════════════
//  ТОСТ
// ══════════════════════════════════════════════════════════

function showToast(msg, isError = false) {
  if (window.toastr) {
    const opts = { timeOut:2600, positionClass:'toast-top-center', closeButton:false };
    isError ? toastr.error(msg,'',opts) : toastr.success(msg,'',opts);
    return;
  }
  document.getElementById('sa-toast')?.remove();
  const t = document.createElement('div');
  t.id='sa-toast'; t.className=`sa-toast ${isError?'sa-toast-error':'sa-toast-ok'}`; t.textContent=msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('sa-toast-show'));
  setTimeout(() => { t.classList.remove('sa-toast-show'); setTimeout(()=>t.remove(),350); }, 2600);
}

// ══════════════════════════════════════════════════════════
//  ЗАГРУЗКА ИЗОБРАЖЕНИЯ → BASE64
// ══════════════════════════════════════════════════════════

function pickImage(onResult, maxPx) {
  maxPx = maxPx || 900; // макс размер стороны
  const inp = document.createElement('input');
  inp.type='file'; inp.accept='image/jpeg,image/png,image/webp,image/gif'; inp.style.display='none';
  document.body.appendChild(inp);
  inp.addEventListener('change', () => {
    const file = inp.files?.[0];
    if (!file) { inp.remove(); return; }
    if (file.size > 10*1024*1024) { showToast('✗ Файл > 10MB',true); inp.remove(); return; }
    const reader = new FileReader();
    reader.onerror = () => { inp.remove(); showToast('✗ Ошибка чтения',true); };
    reader.onload = e => {
      inp.remove();
      // Сжимаем через canvas: resize + JPEG 0.78
      const img = new Image();
      img.onerror = () => onResult(e.target.result); // fallback без сжатия
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const compressed = c.toDataURL('image/jpeg', 0.78);
        onResult(compressed);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  inp.click();
}

// ══════════════════════════════════════════════════════════
//  РЕНДЕР АВАТАРА ПЕРСОНАЖА
// ══════════════════════════════════════════════════════════

function renderCharAvatar(char, size) {
  size = size || 34;
  if (!char) return `<div class="sa-avatar sa-avatar-initial" style="width:${size}px;height:${size}px;background:#7bbde822;border:2px solid #7bbde8;color:#7bbde8;font-size:${Math.round(size*0.44)}px">?</div>`;
  const name = char.name === '{{user}}' ? getUserName() : (char.name || '?');
  const initial = (name.trim()[0] || '?').toUpperCase();
  const color = char.color || '#7bbde8';
  if (char.avatar) {
    return `<img class="sa-avatar sa-avatar-img" src="${saEsc(char.avatar)}" style="width:${size}px;height:${size}px;border:2px solid ${color}" alt="${saEsc(initial)}" draggable="false">`;
  }
  return `<div class="sa-avatar sa-avatar-initial" style="width:${size}px;height:${size}px;background:${color}22;border:2px solid ${color};color:${color};font-size:${Math.round(size*0.44)}px">${saEsc(initial)}</div>`;
}

function renderCharAvatarSmall(char) {
  const name = char.name === '{{user}}' ? getUserName() : (char.name || '?');
  const initial = (name.trim()[0] || '?').toUpperCase();
  const color = char.color || '#7bbde8';
  if (char.avatar) return `<img class="sa-dot-avatar" src="${saEsc(char.avatar)}" style="border-color:${color}" title="${saEsc(name)}" draggable="false">`;
  return `<span class="sa-dot-initial" style="background:${color}33;border-color:${color};color:${color}" title="${saEsc(name)}">${saEsc(initial)}</span>`;
}

// ══════════════════════════════════════════════════════════
//  УМНЫЙ ИНЖЕКТ
//  Компактный, 3-5 строк. Содержит инструкцию для AI.
// ══════════════════════════════════════════════════════════

function buildInjectText(world) {
  if (!world?.locations?.length) return null;
  const s = getSettings();
  const loc = world.locations.find(l => l.id === world.currentLocationId) || world.locations[0];
  if (!loc) return null;

  const lines = [];

  // ── Строка 1: Текущая локация ─────────────────────────
  const charsHere = (world.characters || [])
    .filter(c => c.locationId === loc.id)
    .map(c => c.name === '{{user}}' ? getUserName() : c.name);
  const exits = (loc.connections || [])
    .map(cid => world.locations.find(l => l.id === cid)?.name).filter(Boolean);

  const p = [`📍 ${loc.name}`];
  if (loc.atmosphere)        p.push(`«${loc.atmosphere}»`);
  if (loc.items?.length)     p.push(`[${loc.items.slice(0,4).join(', ')}]`);
  if (charsHere.length)      p.push(`Здесь: ${charsHere.join(', ')}`);
  if (loc.visitableNpcs?.length) p.push(`Встретить: ${loc.visitableNpcs.join(', ')}`);
  if (exits.length)          p.push(`→ ${exits.join(' / ')}`);
  lines.push(`[ЛОКАЦИЯ: ${p.join(' | ')}]`);

  // ── Строка 2: Где остальные персонажи ─────────────────
  const elsewhere = (world.characters || [])
    .filter(c => c.locationId && c.locationId !== loc.id)
    .map(c => {
      const ln = world.locations.find(l => l.id === c.locationId)?.name || '?';
      return `${c.name === '{{user}}' ? getUserName() : c.name}→${ln}`;
    });
  if (elsewhere.length) lines.push(`[ДРУГИЕ: ${elsewhere.join(' | ')}]`);

  // ── Строка 3: Жилище если персонаж дома ───────────────
  if (s.injectHome) {
    for (const owner of (world.characters || []).filter(c => c.home && c.locationId === loc.id)) {
      const h = owner.home;
      if (!h?.rooms?.length) continue;
      const oName = owner.name === '{{user}}' ? getUserName() : owner.name;
      const rList = h.rooms.map(r => {
        const itms = r.items?.length ? `(${r.items.slice(0,3).join(', ')})` : '';
        return `${r.icon||''}${r.name}${itms}`;
      }).join(', ');
      lines.push(`[ЖИЛИЩЕ ${oName}: ${h.name || 'дом'} — ${rList}]`);
    }
  }

  // ── Строка 4: Инструкция для AI ───────────────────────
  lines.push(`[КАРТА-ИНСТРУКЦИЯ: Учитывай эту локацию при описании сцены — её предметы, атмосферу, присутствующих персонажей. При переходе в другое место описывай его детали.]`);

  return lines.join('\n');
}

function onBeforeCombinePrompts(chat) {
  if (!getSettings().enabled) return;
  const inject = buildInjectText(getWorld());
  if (!inject) return;
  const arr = Array.isArray(chat) ? chat : (chat?.chat ?? null);
  if (arr) arr.splice(1, 0, { role:'system', content:inject });
}

// ══════════════════════════════════════════════════════════
//  АВТО-ТРЕКИНГ ДВИЖЕНИЯ ИЗ ТЕКСТА AI
//  Парсит ответы на глаголы движения → предлагает обновить карту
// ══════════════════════════════════════════════════════════

const MOVE_VERB_PATTERN = [
  'вош(?:ёл|ла|ли|ел)',
  'при(?:шёл|шла|шли|йти|дёт|дёшь)',
  'перешёл|перешла|перешли',
  'направил(?:а|и|ся|ась|ись)?(?:с[яь])?',
  'оказал(?:а|и)?с[яь]',
  'переместил(?:а|и)?с[яь]',
  'двинул(?:а|и)?с[яь]',
  'прошёл|прошла|прошли',
  'зашёл|зашла|зашли',
  'пошёл|пошла|пошли',
  'отправил(?:а|и)?с[яь]',
  'появил(?:а|и)?с[яь]',
  'вернул(?:а|и)?с[яь]',
  'поднял(?:а|и)?с[яь]',
  'спустил(?:а|и)?с[яь]',
  'ушёл|ушла|ушли',
  'вышел|вышла|вышли',
].join('|');

function rxEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detectMovements(text, world) {
  if (!text || !world?.locations?.length || !world?.characters?.length) return [];

  const chars = (world.characters || []).filter(c => {
    const n = c.name === '{{user}}' ? getUserName() : c.name;
    return n && n.length > 1;
  });
  const locNames = world.locations.map(l => l.name).filter(n => n && n.length > 1);
  if (!chars.length || !locNames.length) return [];

  const moves = [];
  const locsRx = locNames.map(rxEsc).join('|');

  for (const char of chars) {
    const charName = char.name === '{{user}}' ? getUserName() : char.name;
    const nameRx = rxEsc(charName);
    // Паттерн: [Имя] ... глагол ... (в|на|к) ... [Локация]  в пределах 120 символов
    const rx = new RegExp(
      `${nameRx}[^.!?\\n]{0,80}(?:${MOVE_VERB_PATTERN})[^.!?\\n]{0,25}(?:в|на|к|до)\\s+(${locsRx})`,
      'iu'
    );
    const m = rx.exec(text);
    if (m) {
      const locName = m[1];
      const loc = world.locations.find(l => l.name.toLowerCase() === locName.toLowerCase());
      if (loc && loc.id !== char.locationId) {
        moves.push({ charId: char.id, charName, locId: loc.id, locName: loc.name });
      }
    }
  }
  return moves;
}

// Тост подтверждения движений
let _pendingMoves = [];
function showMovementToast(moves, world) {
  if (!moves.length) return;
  _pendingMoves = moves;
  document.getElementById('sa-move-toast')?.remove();

  const el = document.createElement('div');
  el.id = 'sa-move-toast';
  el.className = 'sa-move-toast';
  const moveLine = moves.map(m => `<b>${m.charName}</b> → ${m.locName}`).join('<br>');
  el.innerHTML = `<div class="sa-move-icon">🚶</div>
    <div class="sa-move-body"><div class="sa-move-title">Обновить карту?</div><div class="sa-move-detail">${moveLine}</div></div>
    <div class="sa-move-btns"><button id="sa-move-yes">✓</button><button id="sa-move-no">✕</button></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('sa-move-show'));

  el.querySelector('#sa-move-yes')?.addEventListener('click', () => {
    const w = getWorld();
    _pendingMoves.forEach(mv => { const c = w.characters.find(c=>c.id===mv.charId); if(c) c.locationId=mv.locId; });
    saveWorld(w); applyLocationWallpaper(w);
    const prev = document.getElementById('sa-inject-preview');
    if (prev) prev.textContent = buildInjectText(w) || '';
    showToast('✓ Карта обновлена');
    _pendingMoves = [];
    el.classList.remove('sa-move-show'); setTimeout(()=>el.remove(), 300);
  });
  el.querySelector('#sa-move-no')?.addEventListener('click', () => {
    el.classList.remove('sa-move-show'); setTimeout(()=>el.remove(), 300);
  });
  setTimeout(() => { if (document.body.contains(el)) { el.classList.remove('sa-move-show'); setTimeout(()=>el.remove(),300); } }, 9000);
}

function onCharacterMessageRendered(data) {
  const s = getSettings();
  if (!s.enabled || !s.autoTrackMovement) return;
  const world = getWorld();
  if (!world?.locations?.length) return;

  // Авто-синхронизируем юзера к текущей локации если у него нет позиции
  syncUserToCurrentLocation(world);

  // Читаем последние N сообщений ТОЛЬКО от AI (не от юзера)
  const n = s.contextMessages || 15;
  let text = '';
  try {
    const ctx = getCtx();
    const chat = ctx.chat || [];
    // Берём только AI-сообщения (is_user === false)
    const aiMessages = chat.filter(m => !m.is_user && !m.is_system).slice(-n);
    text = aiMessages.map(m => m.mes || '').join('\n');

    // Fallback — DOM последнего рендеренного сообщения
    if (!text) {
      const msgId = typeof data === 'object' ? data?.messageId : data;
      if (msgId != null) {
        const el = document.querySelector(`[mesid="${msgId}"] .mes_text`);
        text = el?.innerText || el?.textContent || '';
      }
    }
  } catch {}

  if (!text) return;
  const moves = detectMovements(text, world);
  if (moves.length) showMovementToast(moves, world);
}

// Юзер всегда должен быть в текущей локации если у него нет позиции
function syncUserToCurrentLocation(world) {
  if (!world?.characters || !world?.currentLocationId) return false;
  const user = world.characters.find(c => c.id === 'u_user');
  if (user && !user.locationId) {
    user.locationId = world.currentLocationId;
    saveWorld(world);
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ ПЕРСОНАЖЕЙ ИЗ КАРТОЧКИ
//  Сканирует description/first_mes на имена собственные (рус.)
// ══════════════════════════════════════════════════════════

const COMMON_WORDS = new Set([
  'Это','Она','Он','Они','Нет','Да','Как','Что','Где','Когда','Почему',
  'Хорошо','Конечно','Можно','Нельзя','Всё','Ладно','Ничего','Подожди',
  'Послушай','Скажи','Понял','Поняла','Знаю','Знаешь','Думаю','Просто',
  'Только','Тогда','Значит','Кстати','Стоп','Нет','Нам','Вам','Ему','Ей',
]);

function extractCharactersFromCard(ctx) {
  const char = ctx.characters?.[ctx.characterId];
  if (!char) return [];
  const text = [char.description, char.personality, char.scenario, char.first_mes, char.mes_example].filter(Boolean).join('\n');
  const found = [];

  // Имена после слов-указателей отношений
  const relRx = /(?:её|его|мою?|твою?|свою?)\s+(?:сестр[уаы]|брат[ау]?|маму?|папу?|друга?|подруг[иу]?|соседк[уи]?|соседа?|тёт[кую]?|дяд[ею]?|бабушк[иу]?|дедушк[уи]?)\s+([А-ЯЁ][а-яёА-ЯЁ]{1,})/gu;
  let m;
  while ((m = relRx.exec(text)) !== null) {
    const n = m[1]; if (!found.includes(n) && n !== char.name) found.push(n);
  }

  // Прямые обращения в диалогах: «— Имя,» или «Имя!»
  const dialogRx = /[-—]\s*([А-ЯЁ][а-яё]{2,})(?:[,!]|\s+(?:скажи|послушай|подожди|смотри|погоди))/gu;
  while ((m = dialogRx.exec(text)) !== null) {
    const n = m[1]; if (!found.includes(n) && n !== char.name && !COMMON_WORDS.has(n)) found.push(n);
  }

  // Теги {{name}} и [[name]]
  const tagRx = /(?:\[\[|\{\{)([А-ЯЁа-яё][а-яёА-ЯЁ]{2,})(?:\]\]|\}\})/gu;
  while ((m = tagRx.exec(text)) !== null) {
    const n = m[1][0].toUpperCase() + m[1].slice(1);
    if (!found.includes(n) && n.toLowerCase() !== 'user' && n.toLowerCase() !== 'char') found.push(n);
  }

  return found.slice(0, 8);
}

// ══════════════════════════════════════════════════════════
//  AI ГЕНЕРАЦИЯ
// ══════════════════════════════════════════════════════════

async function generateWorld() {
  const s=getSettings(), gen=s.gen;
  if (!s.api_key) throw new Error('API ключ не задан — откройте ⚙️');
  const ctx=getCtx(), char=ctx.characters?.[ctx.characterId];
  if (!char) throw new Error('Выберите персонажа и откройте чат');
  const lang=s.lang==='ru'?'Russian':'English';
  const [locMin,locMax]=(gen.locationCount||'4-7').split('-');
  const userName=ctx.name1||'User';
  let wi='';
  if (gen.includeLorebook) try { wi=(ctx.worldInfoString||'').slice(0,2000); } catch{}

  // Извлекаем персонажей из карточки
  const cardChars = extractCharactersFromCard(ctx);
  const cardCharsBlock = cardChars.length
    ? `\nKNOWN NPCs FROM CHARACTER CARD: ${cardChars.join(', ')} — include these as characters with appropriate types and locations.`
    : '';

  const charBlock = gen.includeCard ? `CHARACTER: ${char.name||'Unknown'}
Description: ${(char.description||'').slice(0,600)}
Personality: ${(char.personality||'').slice(0,300)}
Scenario: ${(char.scenario||'').slice(0,400)}
First message: ${(char.first_mes||'').slice(0,400)}` : '';

  const prompt = `${charBlock}
LOREBOOK: ${wi||'(none)'}${cardCharsBlock}

Create ${locMin}-${locMax||locMin} interconnected locations for this story.
${gen.generateNpcs ? `Also generate ${gen.npcCount||3} additional named NPCs beyond those already in the card.` : ''}
${gen.includeUser ? `Include "${userName}" as the player character (type "user").` : ''}
${gen.userWish?.trim() ? `\nADDITIONAL REQUIREMENTS: ${gen.userWish}` : ''}

Rules:
- The main character (${char.name}) should be type "main"
- Characters found in the card description should be type "main" or "npc" based on importance
- Each character should start at a logical location based on their role
- visitableNpcs on locations = background characters who might be encountered there

Respond in ${lang}. Return ONLY valid JSON:
{
  "worldDescription": "1-2 sentence world overview",
  "locations": [
    {
      "id": "loc_1",
      "name": "...",
      "icon": "🏠",
      "description": "2-3 sensory sentences",
      "atmosphere": "1 evocative sentence",
      "items": ["item", "item", "item"],
      "connections": ["loc_2"],
      "visitableNpcs": ["background NPC name"],
      "isDefault": true
    }
  ],
  "characters": [
    {"name": "${char.name}", "icon": "🧑", "type": "main", "locationId": "loc_1", "color": "#7bbde8"}${gen.includeUser ? `,\n    {"name": "${userName}", "icon": "🧑", "type": "user", "locationId": "loc_1", "color": "#a78bfa"}` : ''}
  ]
}`;

  const resp = await fetch(`${s.api_url.replace(/\/+$/,'')}/chat/completions`, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${s.api_key}`},
    body:JSON.stringify({model:s.model,temperature:0.85,max_tokens:4000,messages:[
      {role:'system',content:gen.systemPrompt||DEFAULT_SYSTEM_PROMPT},
      {role:'user',content:prompt}
    ]}),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text().catch(()=>'')).slice(0,180)}`);
  const data=await resp.json();
  const rawText=data.choices?.[0]?.message?.content||'';
  const match=rawText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('API вернул некорректный JSON');
  const raw=JSON.parse(match[0]);
  if (!Array.isArray(raw.locations)||!raw.locations.length) throw new Error('Список локаций пуст');
  return raw;
}

// ══════════════════════════════════════════════════════════
//  ГЕНЕРАЦИЯ ЖИЛИЩ
//  Для каждого персонажа типа user/main генерирует дом + комнаты
// ══════════════════════════════════════════════════════════

async function generateHomes(charIds) {
  const s = getSettings(), gen = s.gen;
  if (!s.api_key) throw new Error('API ключ не задан — откройте ⚙️');
  const world = getWorld();
  const ctx = getCtx();
  const char = ctx.characters?.[ctx.characterId];
  const lang = s.lang === 'ru' ? 'Russian' : 'English';

  // Персонажи для генерации (user + main, или конкретные)
  const targets = (world.characters || []).filter(c =>
    (c.type === 'user' || c.type === 'main') &&
    (!charIds || charIds.includes(c.id))
  );
  if (!targets.length) throw new Error('Нет персонажей типа «юзер» или «главный»');

  const charInfo = targets.map(c => {
    const n = c.name === '{{user}}' ? (ctx.name1 || 'User') : c.name;
    return `- ${n} (${c.type}, сейчас в: ${world.locations.find(l=>l.id===c.locationId)?.name||'неизвестно'})`;
  }).join('\n');

  const charBlock = gen.includeCard && char ? `
MAIN CHARACTER CARD: ${char.name}
Description: ${(char.description||'').slice(0,500)}
Scenario: ${(char.scenario||'').slice(0,300)}` : '';

  const prompt = `${charBlock}
STORY WORLD: ${world.worldDescription || '(roleplay world)'}
EXISTING LOCATIONS: ${world.locations.map(l=>l.name).join(', ')}

CHARACTERS NEEDING HOMES:
${charInfo}

For each character, create a personal home/residence that fits their personality and role in the story.
Each home should have 3-5 rooms with evocative names and items.
Respond in ${lang}. Return ONLY valid JSON:
{
  "homes": [
    {
      "characterName": "Name",
      "home": {
        "icon": "🏠",
        "name": "Apartment name",
        "description": "2 sentences about the home",
        "rooms": [
          {
            "icon": "🛋️",
            "name": "Room name",
            "description": "Brief sensory description",
            "items": ["item1", "item2", "item3"]
          }
        ]
      }
    }
  ]
}`;

  const resp = await fetch(`${s.api_url.replace(/\/+$/,'')}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':`Bearer ${s.api_key}`},
    body: JSON.stringify({
      model: s.model, temperature: 0.85, max_tokens: 3000,
      messages: [
        {role:'system', content: gen.systemPrompt || DEFAULT_SYSTEM_PROMPT},
        {role:'user', content: prompt}
      ]
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text().catch(()=>'')).slice(0,180)}`);
  const data = await resp.json();
  const rawText = data.choices?.[0]?.message?.content || '';
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('API вернул некорректный JSON');
  const raw = JSON.parse(match[0]);
  if (!Array.isArray(raw.homes) || !raw.homes.length) throw new Error('Список жилищ пуст');
  return { homes: raw.homes, targets };
}


// ══════════════════════════════════════════════════════════
//  КОНСТАНТЫ
// ══════════════════════════════════════════════════════════

function saEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function updateBadge() { const n=getWorld().locations?.length||0; n>0?$('#sa-badge').text(n).show():$('#sa-badge').hide(); }
function refreshMain() {
  const el=document.getElementById('sa-modal'); if (!el) return false;
  el.outerHTML=buildMainHTML(); requestAnimationFrame(()=>bindMainEvents()); return true;
}

const CHAR_COLORS=['#7bbde8','#a78bfa','#86efac','#fcd34d','#f87171','#fb923c','#34d399','#e879f9','#94a3b8','#67e8f9'];
const PERSON_ICONS=['🧑','👤','👦','👧','👩','👨','🧔','👴','👵','🧙','🧝','🧛','🤺','🥷','💂','🧑‍💼','🧑‍🎤','🧑‍🔬'];
const LOC_ICONS=['🏠','🏰','🏢','🏬','🏛️','🌲','🌿','🌙','🌌','🌊','🏖️','🏔️','🗺️','🚪','🔮','🍺','🎭','⚗️','🔥','❄️','⚔️','🕯️','🛏️','🪞','🌃','🏚️','🌄','🎠','🎪','🌁'];
const HOME_ICONS=['🏠','🏡','🏢','🏰','🛖','⛺','🏗️'];
const ROOM_ICONS=['🚪','🛋️','🛏️','🍳','🚿','📚','🎮','💻','🪞','🌿','🎨','🏋️','🎵','🌙'];

let _activeTab='map';

// ══════════════════════════════════════════════════════════
//  ГЛАВНЫЙ HTML
// ══════════════════════════════════════════════════════════

function buildMainHTML() {
  const world=getWorld(), s=getSettings(), has=world.locations?.length>0;
  const tp=(t)=>_activeTab===t;
  return `<div id="sa-modal">
  <div id="sa-head">
    <span id="sa-head-title"><i class="fa-solid fa-map"></i>&nbsp;СОРААТЛАС</span>
    <div id="sa-head-right">
      <label class="sa-toggle-label"><input type="checkbox" id="sa-inject-toggle" ${s.enabled?'checked':''}><span class="sa-tog ${s.enabled?'sa-tog-on':''}"></span><span class="sa-inj-label">инъекция</span></label>
      <button class="sa-head-btn sa-btn-gen" id="sa-btn-generate" title="Сгенерировать"><i class="fa-solid fa-wand-sparkles"></i></button>
      <button class="sa-head-btn" id="sa-btn-clear" ${!has?'disabled':''} title="Удалить карту"><i class="fa-solid fa-trash-can"></i></button>
    </div>
  </div>
  <div id="sa-tabs">
    <button class="sa-tab ${tp('map')?'sa-tab-on':''}" data-tab="map">🗺️ Карта</button>
    <button class="sa-tab ${tp('chars')?'sa-tab-on':''}" data-tab="chars">👥 Персонажи</button>
    <button class="sa-tab ${tp('homes')?'sa-tab-on':''}" data-tab="homes">🏠 Жилища</button>
    <button class="sa-tab ${tp('settings')?'sa-tab-on':''}" data-tab="settings">⚙️</button>
  </div>
  <div id="sa-tab-map" class="sa-tab-pane" ${!tp('map')?'style="display:none"':''}>${buildMapTab(world,has)}</div>
  <div id="sa-tab-chars" class="sa-tab-pane" ${!tp('chars')?'style="display:none"':''}>${buildCharsTab(world)}</div>
  <div id="sa-tab-homes" class="sa-tab-pane" ${!tp('homes')?'style="display:none"':''}>${buildHomesTab(world)}</div>
  <div id="sa-tab-settings" class="sa-tab-pane" ${!tp('settings')?'style="display:none"':''}>${buildSettingsTab()}</div>
</div>`;
}

function buildMapTab(world,has) {
  if (!has) return `<div class="sa-empty"><div class="sa-empty-icon">🗺️</div><div class="sa-empty-title">Мир не создан</div><div class="sa-empty-hint"><i class="fa-solid fa-wand-sparkles"></i> — сгенерировать через ИИ</div><button class="sa-add-first-btn" id="sa-btn-add-loc"><i class="fa-solid fa-plus"></i> Добавить локацию</button></div>`;
  return `${world.worldDescription?`<div id="sa-world-desc">${saEsc(world.worldDescription)}</div>`:''}
  <div id="sa-map-grid">${world.locations.map(loc=>renderTile(loc,world)).join('')}</div>
  <button class="sa-map-add-btn" id="sa-btn-add-loc"><i class="fa-solid fa-plus"></i> Добавить локацию</button>
  <div id="sa-foot"><div id="sa-foot-label"><i class="fa-solid fa-location-dot"></i> текущая:</div>
  <div id="sa-inject-preview">${saEsc(buildInjectText(world)||'— нет активной локации')}</div></div>`;
}

function renderTile(loc,world) {
  const active=loc.id===world.currentLocationId;
  const charsHere=(world.characters||[]).filter(c=>c.locationId===loc.id);
  return `<div class="sa-tile${active?' sa-tile-active':''}" data-locid="${saEsc(loc.id)}">
    <button class="sa-tile-edit-btn" data-editid="${saEsc(loc.id)}"><i class="fa-solid fa-pen"></i></button>
    ${loc.image?`<div class="sa-tile-cover" style="background-image:url(${loc.image})"></div>`:`<div class="sa-tile-icon">${loc.icon||'📍'}</div>`}
    <div class="sa-tile-name">${saEsc(loc.name)}</div>
    ${charsHere.length?`<div class="sa-tile-chars">${charsHere.slice(0,5).map(c=>renderCharAvatarSmall(c)).join('')}</div>`:''}
    ${active?'<div class="sa-tile-active-dot"></div>':''}
  </div>`;
}

function buildCharsTab(world) {
  const chars=world.characters||[];
  return `<div class="sa-chars-wrap">
  <div class="sa-chars-header"><span class="sa-section-lbl">Персонажи (${chars.length})</span><button class="sa-small-btn" id="sa-add-char"><i class="fa-solid fa-plus"></i> Добавить</button></div>
  <div class="sa-chars-list">${chars.map(c=>{
    const locName=world.locations.find(l=>l.id===c.locationId)?.name||'—';
    const dispName=c.name==='{{user}}'?`{{user}} (${getUserName()})`:c.name;
    const tl={user:'юзер',main:'главный',npc:'нпс'}[c.type]||c.type;
    return `<div class="sa-char-row">
      <div class="sa-char-avatar-wrap" data-charavatarid="${saEsc(c.id)}" title="Нажать — сменить фото">
        ${renderCharAvatar(c,38)}
        <div class="sa-avatar-overlay"><i class="fa-solid fa-camera"></i></div>
      </div>
      <div class="sa-char-row-info">
        <div class="sa-char-row-name">${saEsc(dispName)}</div>
        <div class="sa-char-row-meta"><span class="sa-type-badge sa-type-${c.type}">${tl}</span> · 📍 ${saEsc(locName)}</div>
      </div>
      <div class="sa-char-row-actions">
        <button class="sa-char-edit-btn" data-charid="${saEsc(c.id)}"><i class="fa-solid fa-pen"></i></button>
        ${c.id!=='u_user'?`<button class="sa-char-del-btn" data-charid="${saEsc(c.id)}"><i class="fa-solid fa-trash"></i></button>`:''}
      </div>
    </div>`;
  }).join('')}</div></div>`;
}

function buildHomesTab(world) {
  const hc=(world.characters||[]).filter(c=>c.type==='user'||c.type==='main');
  const hasHomes = hc.some(c=>c.home);
  return `<div class="sa-homes-wrap">
  <div class="sa-homes-topbar">
    <span class="sa-section-lbl">Жилища (${hc.filter(c=>c.home).length}/${hc.length})</span>
    <button class="sa-small-btn sa-btn-gen-homes" id="sa-btn-gen-homes" ${!hc.length?'disabled':''}>
      <i class="fa-solid fa-wand-sparkles"></i> Сгенерировать
    </button>
  </div>
  ${!hc.length
    ? `<div class="sa-empty"><div class="sa-empty-icon">🏠</div><div class="sa-empty-title">Нет персонажей</div><div class="sa-empty-hint">Добавьте персонажей типа «юзер» или «главный» на вкладке 👥</div></div>`
    : `<div class="sa-homes-list">${hc.map(c=>{
    const dn=c.name==='{{user}}'?getUserName():c.name, home=c.home||null;
    // Показываем где персонаж сейчас
    const locNow = world.locations.find(l=>l.id===c.locationId);
    const isHome = home && c.locationId === c.locationId; // всегда true, просто для наглядности
    return `<div class="sa-home-card">
      <div class="sa-home-header">
        ${renderCharAvatar(c,32)}
        <div class="sa-home-owner-info">
          <div class="sa-home-owner-name">${saEsc(dn)}</div>
          <div class="sa-home-owner-loc">${locNow ? `📍 ${saEsc(locNow.name)}` : '<span class="sa-dim">—</span>'}</div>
        </div>
        <button class="sa-home-edit-btn" data-charid="${saEsc(c.id)}">${home?'<i class="fa-solid fa-pen"></i>':'<i class="fa-solid fa-plus"></i>'}</button>
      </div>
      ${home
        ?`<div class="sa-home-name-row">
          <span class="sa-home-icon-big">${home.icon||'🏠'}</span>
          <div><div class="sa-home-name">${saEsc(home.name||'Жилище')}</div>
          ${home.description?`<div class="sa-home-desc">${saEsc(home.description)}</div>`:''}
          </div>
        </div>
        <div class="sa-rooms-label">Комнаты <span class="sa-dim">(${(home.rooms||[]).length})</span></div>
        <div class="sa-rooms-grid">
          ${(home.rooms||[]).map(r=>`<div class="sa-room-tile">
            <button class="sa-room-edit-btn" data-charid="${saEsc(c.id)}" data-roomid="${saEsc(r.id)}"><i class="fa-solid fa-pen"></i></button>
            <div class="sa-room-icon">${r.icon||'🚪'}</div>
            <div class="sa-room-name">${saEsc(r.name)}</div>
            ${r.items?.length?`<div class="sa-room-items">${r.items.slice(0,2).map(i=>`<span class="sa-badge">${saEsc(i)}</span>`).join('')}</div>`:''}
          </div>`).join('')}
          <button class="sa-add-room-btn" data-charid="${saEsc(c.id)}" title="Добавить комнату"><i class="fa-solid fa-plus"></i></button>
        </div>`
        :`<div class="sa-no-home">
          <span class="sa-dim">Жилище не добавлено</span>
          <button class="sa-home-gen-one-btn sa-small-btn" data-charid="${saEsc(c.id)}"><i class="fa-solid fa-wand-sparkles"></i></button>
         </div>`}
    </div>`;
  }).join('')}</div>`}
</div>`;
}


function buildSettingsTab() {
  const s=getSettings(), gen=s.gen;
  return `<div class="sa-settings-body">
  <div class="sa-settings-section">
    <div class="sa-settings-section-title">🔑 API</div>
    <div class="sa-sfield"><label>API URL</label><input id="sa-s-url" type="text" class="sa-sinput" placeholder="https://api.openai.com/v1" value="${saEsc(s.api_url||'')}"></div>
    <div class="sa-sfield"><label>API Ключ</label>
      <div class="sa-key-row"><input id="sa-s-key" type="password" class="sa-sinput" placeholder="sk-..." value="${saEsc(s.api_key||'')}"><button class="sa-key-eye" id="sa-key-eye"><i class="fa-solid fa-eye"></i></button></div>
      <div class="sa-key-status">${s.api_key?'<span class="sa-key-ok">✓ ключ задан</span>':'<span class="sa-key-empty">ключ не задан</span>'}</div>
    </div>
    <div class="sa-row-2">
      <div class="sa-sfield"><label>Модель</label><input id="sa-s-model" type="text" class="sa-sinput" placeholder="gpt-4o-mini" value="${saEsc(s.model||'')}"></div>
      <div class="sa-sfield"><label>Язык</label><select id="sa-s-lang" class="sa-sinput"><option value="ru" ${s.lang==='ru'?'selected':''}>Русский</option><option value="en" ${s.lang==='en'?'selected':''}>English</option></select></div>
    </div>
  </div>
  <div class="sa-settings-section">
    <div class="sa-settings-section-title">⚡ Поведение</div>
    <div style="display:flex;flex-direction:column;gap:7px">
      <label class="sa-chk-label" style="width:100%;box-sizing:border-box">
        <input type="checkbox" id="sa-auto-wallpaper" ${s.autoWallpaper?'checked':''}>
        <div><div style="font-size:0.78rem">🖼️ Менять обои ST при смене локации</div><div class="sa-hint">Обложка локации становится фоном ST</div></div>
      </label>
      <label class="sa-chk-label" style="width:100%;box-sizing:border-box">
        <input type="checkbox" id="sa-auto-track" ${s.autoTrackMovement?'checked':''}>
        <div><div style="font-size:0.78rem">🚶 Авто-трекинг движений</div><div class="sa-hint">Когда AI описывает переход — предложить обновить карту</div></div>
      </label>
      <label class="sa-chk-label" style="width:100%;box-sizing:border-box">
        <input type="checkbox" id="sa-inject-home" ${s.injectHome?'checked':''}>
        <div><div style="font-size:0.78rem">🏠 Жилище в инжекте</div><div class="sa-hint">Если персонаж дома — AI знает его комнаты и обстановку</div></div>
      </label>
    </div>
    <div class="sa-sfield" style="margin-top:8px">
      <label>📖 Читать последних сообщений <span class="sa-hint">для трекинга движений</span></label>
      <input id="sa-ctx-messages" type="number" class="sa-sinput" min="1" max="50" value="${s.contextMessages||15}" style="width:80px">
    </div>
  </div>
  <div class="sa-settings-section">
    <div class="sa-settings-section-title">👁 Предпросмотр инжекта</div>
    <pre class="sa-inject-full-preview">${saEsc(buildInjectText(getWorld())||'— мир не создан')}</pre>
    <div class="sa-dim" style="font-size:0.65rem;margin-top:4px">Это вставляется системным сообщением перед каждым ответом AI</div>
  </div>
  <div class="sa-settings-section">
    <div class="sa-settings-section-title">🤖 Системный промпт генерации</div>
    <textarea id="sa-gen-sysprompt" class="sa-sinput" rows="4" style="resize:vertical">${saEsc(gen.systemPrompt||DEFAULT_SYSTEM_PROMPT)}</textarea>
    <button class="sa-small-btn" id="sa-reset-sysprompt" style="margin-top:4px">↩ Сбросить</button>
  </div>
  <div class="sa-settings-section">
    <div class="sa-settings-section-title">🌍 Параметры генерации</div>
    <div class="sa-row-2">
      <div class="sa-sfield"><label>Локаций</label><input id="sa-gen-loccount" type="text" class="sa-sinput" placeholder="4-7" value="${saEsc(gen.locationCount||'4-7')}"></div>
      <div class="sa-sfield"><label>НПС доп.</label><input id="sa-gen-npccount" type="number" class="sa-sinput" min="0" max="10" value="${gen.npcCount||3}"></div>
    </div>
    <div class="sa-checkboxes">
      <label class="sa-chk-label"><input type="checkbox" id="sa-gen-card" ${gen.includeCard?'checked':''}}> Карточка</label>
      <label class="sa-chk-label"><input type="checkbox" id="sa-gen-lorebook" ${gen.includeLorebook?'checked':''}}> Лорбук</label>
      <label class="sa-chk-label"><input type="checkbox" id="sa-gen-user" ${gen.includeUser?'checked':''}}> {{user}}</label>
      <label class="sa-chk-label"><input type="checkbox" id="sa-gen-npcs" ${gen.generateNpcs?'checked':''}}> Доп. НПС</label>
    </div>
    <div class="sa-sfield" style="margin-top:8px"><label>Пожелания <span class="sa-hint">добавляются к запросу</span></label>
      <textarea id="sa-gen-wish" class="sa-sinput" rows="2" placeholder="тёмное фэнтези, маленький городок...">${saEsc(gen.userWish||'')}}</textarea>
    </div>
  </div>
</div>`;
}


// ══════════════════════════════════════════════════════════
//  ДЕТАЛИ ЛОКАЦИИ
// ══════════════════════════════════════════════════════════

function buildLocationHTML(locId) {
  const world=getWorld(), loc=world.locations.find(l=>l.id===locId);
  if (!loc) return '<div class="sa-empty">Локация не найдена</div>';
  const charsHere=(world.characters||[]).filter(c=>c.locationId===locId);
  const exits=(loc.connections||[]).map(cid=>world.locations.find(l=>l.id===cid)).filter(Boolean);
  const allChars=world.characters||[];
  const isCurrent=loc.id===world.currentLocationId;
  return `<div class="sa-loc-inner">
  ${loc.image?`<div class="sa-loc-cover" style="background-image:url(${loc.image})"></div>`:''}
  <div class="sa-loc-head"><span class="sa-loc-icon">${loc.icon||'📍'}</span><div class="sa-loc-title">${saEsc(loc.name)}</div></div>
  <div class="sa-loc-desc">${saEsc(loc.description||'—')}</div>
  <div class="sa-section"><div class="sa-section-lbl">🌫️ Атмосфера</div><div class="sa-section-val sa-italic">${saEsc(loc.atmosphere||'—')}</div></div>
  <div class="sa-section"><div class="sa-section-lbl">👥 Персонажи здесь</div><div class="sa-flex-wrap" style="gap:8px">
    ${charsHere.length?charsHere.map(c=>{const n=c.name==='{{user}}'?getUserName():c.name;return `<div class="sa-char-here-badge" style="border-color:${c.color||'#7bbde8'}40">${renderCharAvatar(c,28)}<span style="color:${c.color||'#7bbde8'};font-size:0.72rem">${saEsc(n)}</span></div>`;}).join(''):'<span class="sa-dim">Никого нет</span>'}
  </div></div>
  <div class="sa-section"><div class="sa-section-lbl">👀 Можно встретить</div><div class="sa-flex-wrap">
    ${loc.visitableNpcs?.length?loc.visitableNpcs.map(n=>`<span class="sa-badge">${saEsc(n)}</span>`).join(''):'<span class="sa-dim">Никого особого</span>'}
  </div></div>
  <div class="sa-section"><div class="sa-section-lbl">📦 Предметы</div><div class="sa-flex-wrap">
    ${loc.items?.length?loc.items.map(it=>`<span class="sa-badge">${saEsc(it)}</span>`).join(''):'<span class="sa-dim">Пусто</span>'}
  </div></div>
  <div class="sa-section"><div class="sa-section-lbl">🚪 Переходы</div><div class="sa-flex-wrap" id="sa-conn-list">
    ${exits.length?exits.map(c=>`<button class="sa-conn-btn" data-goto="${saEsc(c.id)}">${c.icon||'📍'} ${saEsc(c.name)}</button>`).join(''):'<span class="sa-dim">Нет</span>'}
  </div></div>
  <div class="sa-section"><div class="sa-section-lbl">🚶 Переместить сюда</div><div class="sa-flex-wrap" style="gap:5px">
    ${allChars.map(c=>{const here=c.locationId===locId,n=c.name==='{{user}}'?getUserName():c.name;return `<button class="sa-move-btn${here?' sa-move-here':''}" data-charid="${saEsc(c.id)}" ${here?'disabled':''}>${renderCharAvatarSmall(c)} <span>${saEsc(n)}</span></button>`;}).join('')}
  </div></div>
  <button class="sa-set-btn${isCurrent?' sa-set-btn-active':''}" id="sa-set-current" data-locid="${saEsc(loc.id)}" ${isCurrent?'disabled':''}>${isCurrent?'✓ Текущая локация':'📍 Сделать текущей'}</button>
</div>`;
}

// ══════════════════════════════════════════════════════════
//  РЕДАКТОР ЛОКАЦИИ
// ══════════════════════════════════════════════════════════

function buildLocationEditorHTML(locId) {
  const world=getWorld(), loc=locId?world.locations.find(l=>l.id===locId):null, curIcon=loc?.icon||'🏠';
  const allLocs=world.locations.filter(l=>l.id!==locId);
  return `<div class="sa-editor-inner">
  <div class="sa-editor-title">${!loc?'➕ Новая локация':'✏️ Редактировать'}</div>
  <label>Обложка <span class="sa-hint">JPG/PNG/WebP до 2MB</span></label>
  <div class="sa-cover-upload" id="sa-loc-cover-area">
    ${loc?.image?`<div class="sa-cover-preview" style="background-image:url(${loc.image})"><button type="button" class="sa-cover-remove" id="sa-cover-remove">✕</button></div>`
    :`<button type="button" class="sa-cover-pick" id="sa-cover-pick"><i class="fa-solid fa-image"></i><br><span>Добавить обложку</span></button>`}
  </div>
  <label>Иконка <span class="sa-hint">(если нет обложки)</span></label>
  <div class="sa-icon-picker">${LOC_ICONS.map(ic=>`<button type="button" class="sa-icon-opt${curIcon===ic?' sa-icon-opt-on':''}" data-icon="${ic}">${ic}</button>`).join('')}</div>
  <input type="hidden" id="sa-ed-icon" value="${saEsc(curIcon)}">
  <label>Название *</label><input id="sa-ed-name" type="text" autocomplete="off" placeholder="Название" value="${saEsc(loc?.name||'')}">
  <label>Описание</label><textarea id="sa-ed-desc" rows="3" placeholder="Что видят, слышат, чувствуют...">${saEsc(loc?.description||'')}</textarea>
  <label>Атмосфера <span class="sa-hint">одна фраза</span></label><input id="sa-ed-atm" type="text" placeholder="Тихо и тревожно..." value="${saEsc(loc?.atmosphere||'')}">
  <label>Предметы <span class="sa-hint">каждый с новой строки</span></label><textarea id="sa-ed-items" rows="3" placeholder="диван&#10;старые письма">${saEsc((loc?.items||[]).join('\n'))}</textarea>
  <label>Можно встретить <span class="sa-hint">каждый с новой строки</span></label><textarea id="sa-ed-npcs" rows="2" placeholder="Прохожий&#10;Торговец">${saEsc((loc?.visitableNpcs||[]).join('\n'))}</textarea>
  ${allLocs.length?`<label>Переходы</label><div class="sa-conn-checks">${allLocs.map(l=>`<label class="sa-check-label"><input type="checkbox" class="sa-conn-check" value="${saEsc(l.id)}" ${(loc?.connections||[]).includes(l.id)?'checked':''}>${l.icon||'📍'} ${saEsc(l.name)}</label>`).join('')}</div>`:''}
  ${loc?`<button type="button" id="sa-ed-delete" class="sa-btn-danger">🗑 Удалить локацию</button>`:''}
</div>`;
}

// ══════════════════════════════════════════════════════════
//  РЕДАКТОР ПЕРСОНАЖА
// ══════════════════════════════════════════════════════════

function buildCharEditorHTML(charId) {
  const world=getWorld(), char=charId?world.characters.find(c=>c.id===charId):null, isUser=char?.id==='u_user';
  return `<div class="sa-editor-inner">
  <div class="sa-editor-title">${!char?'➕ Новый персонаж':isUser?'✏️ {{user}}':'✏️ '+saEsc(char.name)}</div>
  <label>Аватар <span class="sa-hint">фото или буква имени</span></label>
  <div class="sa-avatar-editor" id="sa-char-avatar-area">
    <div class="sa-avatar-preview-wrap">
      ${renderCharAvatar(char||{name:'?',color:'#7bbde8'},64)}
      <div class="sa-avatar-btns">
        <button type="button" class="sa-avatar-upload-btn" id="sa-avatar-pick"><i class="fa-solid fa-camera"></i> ${char?.avatar?'Сменить':'Загрузить фото'}</button>
        ${char?.avatar?`<button type="button" class="sa-avatar-remove-btn" id="sa-avatar-remove">✕ Удалить</button>`:''}
      </div>
    </div>
  </div>
  ${!isUser?`<label>Имя *</label><input id="sa-ch-name" type="text" placeholder="Имя" value="${saEsc(char?.name||'')}">`:
  `<div class="sa-dim" style="margin-bottom:8px;font-size:0.72rem">{{user}} — имя берётся из настроек ST</div>`}
  <label>Иконка <span class="sa-hint">(если нет фото)</span></label>
  <div class="sa-icon-picker">${PERSON_ICONS.map(ic=>`<button type="button" class="sa-icon-opt${(char?.icon||'🧑')===ic?' sa-icon-opt-on':''}" data-icon="${ic}">${ic}</button>`).join('')}</div>
  <input type="hidden" id="sa-ch-icon" value="${saEsc(char?.icon||'🧑')}">
  <label>Тип</label>
  <select id="sa-ch-type" ${isUser?'disabled':''}>
    <option value="user" ${char?.type==='user'?'selected':''}>🧑 Юзер</option>
    <option value="main" ${char?.type==='main'?'selected':''}>⭐ Главный</option>
    <option value="npc" ${char?.type==='npc'?'selected':''}>👤 НПС</option>
  </select>
  <label>Цвет акцента</label>
  <div class="sa-color-row">${CHAR_COLORS.map(clr=>`<button type="button" class="sa-color-opt${(char?.color||'#7bbde8')===clr?' sa-color-opt-on':''}" data-color="${clr}" style="background:${clr}"></button>`).join('')}</div>
  <input type="hidden" id="sa-ch-color" value="${saEsc(char?.color||'#7bbde8')}">
  <label>Начальная локация</label>
  <select id="sa-ch-loc"><option value="">— нет —</option>${getWorld().locations.map(l=>`<option value="${saEsc(l.id)}" ${char?.locationId===l.id?'selected':''}>${l.icon||'📍'} ${saEsc(l.name)}</option>`).join('')}</select>
  ${char&&!isUser?`<button type="button" id="sa-ch-delete" class="sa-btn-danger">🗑 Удалить персонажа</button>`:''}
</div>`;
}

function buildHomeEditorHTML(charId) {
  const world=getWorld(), char=world.characters.find(c=>c.id===charId), home=char?.home||{name:'',icon:'🏠',description:'',rooms:[]};
  const name=char?.name==='{{user}}'?getUserName():char?.name||'';
  return `<div class="sa-editor-inner"><div class="sa-editor-title">🏠 Жилище — ${saEsc(name)}</div>
  <label>Иконка</label><div class="sa-icon-picker">${HOME_ICONS.map(ic=>`<button type="button" class="sa-icon-opt${(home.icon||'🏠')===ic?' sa-icon-opt-on':''}" data-icon="${ic}">${ic}</button>`).join('')}</div>
  <input type="hidden" id="sa-hm-icon" value="${saEsc(home.icon||'🏠')}">
  <label>Название</label><input id="sa-hm-name" type="text" placeholder="Квартира, дом..." value="${saEsc(home.name||'')}">
  <label>Описание</label><textarea id="sa-hm-desc" rows="2">${saEsc(home.description||'')}</textarea>
</div>`;
}

function buildRoomEditorHTML(charId, roomId) {
  const world=getWorld(), char=world.characters.find(c=>c.id===charId), room=roomId?char?.home?.rooms?.find(r=>r.id===roomId):null;
  return `<div class="sa-editor-inner"><div class="sa-editor-title">${room?'✏️ Комната':'➕ Новая комната'}</div>
  <label>Иконка</label><div class="sa-icon-picker">${ROOM_ICONS.map(ic=>`<button type="button" class="sa-icon-opt${(room?.icon||'🚪')===ic?' sa-icon-opt-on':''}" data-icon="${ic}">${ic}</button>`).join('')}</div>
  <input type="hidden" id="sa-rm-icon" value="${saEsc(room?.icon||'🚪')}">
  <label>Название *</label><input id="sa-rm-name" type="text" placeholder="Гостиная..." value="${saEsc(room?.name||'')}">
  <label>Описание</label><input id="sa-rm-desc" type="text" value="${saEsc(room?.description||'')}">
  <label>Предметы <span class="sa-hint">каждый с новой строки</span></label><textarea id="sa-rm-items" rows="3">${saEsc((room?.items||[]).join('\n'))}</textarea>
  ${room?`<button type="button" id="sa-rm-delete" class="sa-btn-danger">🗑 Удалить</button>`:''}
</div>`;
}

// ══════════════════════════════════════════════════════════
//  ПОПАПЫ — ЛОКАЦИЯ РЕДАКТОР
// ══════════════════════════════════════════════════════════

async function openLocationEditorPopup(locId) {
  const world=getWorld(), locOrig=locId?world.locations.find(l=>l.id===locId):null;
  const fs={icon:locOrig?.icon||'🏠',name:locOrig?.name||'',desc:locOrig?.description||'',atm:locOrig?.atmosphere||'',items:(locOrig?.items||[]).join('\n'),npcs:(locOrig?.visitableNpcs||[]).join('\n'),conns:[...(locOrig?.connections||[])],image:locOrig?.image||null};
  const popup=new Popup(buildLocationEditorHTML(locId),POPUP_TYPE.CONFIRM,'',{okButton:locId?'💾 Сохранить':'➕ Добавить',cancelButton:'Отмена'});

  requestAnimationFrame(()=>{
    wireIcons('.sa-icon-opt',v=>{fs.icon=v;});
    wireInput('sa-ed-name','name',fs); wireInput('sa-ed-desc','desc',fs); wireInput('sa-ed-atm','atm',fs); wireInput('sa-ed-items','items',fs); wireInput('sa-ed-npcs','npcs',fs);
    document.querySelectorAll('.sa-conn-check').forEach(cb=>cb.addEventListener('change',()=>{fs.conns=Array.from(document.querySelectorAll('.sa-conn-check:checked')).map(e=>e.value);}));
    fs.conns=Array.from(document.querySelectorAll('.sa-conn-check:checked')).map(e=>e.value);

    function bindCoverArea() {
      document.getElementById('sa-cover-pick')?.addEventListener('click',()=>{
        pickImage(data=>{
          fs.image=data;
          const a=document.getElementById('sa-loc-cover-area');
          if (a) { a.innerHTML=`<div class="sa-cover-preview" style="background-image:url(${data})"><button type="button" class="sa-cover-remove" id="sa-cover-remove">✕</button></div>`; bindCoverArea(); }
        });
      });
      document.getElementById('sa-cover-remove')?.addEventListener('click',()=>{
        fs.image=null;
        const a=document.getElementById('sa-loc-cover-area');
        if (a) { a.innerHTML=`<button type="button" class="sa-cover-pick" id="sa-cover-pick"><i class="fa-solid fa-image"></i><br><span>Добавить обложку</span></button>`; bindCoverArea(); }
      });
    }
    bindCoverArea();

    document.getElementById('sa-ed-delete')?.addEventListener('click',()=>{
      popup.complete(null);
      if (!confirm(`Удалить «${world.locations.find(l=>l.id===locId)?.name}»?`)) return;
      world.locations=world.locations.filter(l=>l.id!==locId);
      world.locations.forEach(l=>{l.connections=(l.connections||[]).filter(c=>c!==locId);});
      (world.characters||[]).forEach(c=>{if(c.locationId===locId)c.locationId=world.locations[0]?.id||null;});
      if (world.currentLocationId===locId) world.currentLocationId=world.locations[0]?.id||null;
      saveWorld(world); showToast('✓ Локация удалена'); refreshMain();
    });
  });

  const result=await popup.show(); if (!result) return;
  if (!fs.name.trim()) { showToast('✗ Введите название',true); return; }
  const data={name:fs.name.trim(),icon:fs.icon,description:fs.desc.trim(),atmosphere:fs.atm.trim(),items:fs.items.split('\n').map(s=>s.trim()).filter(Boolean),visitableNpcs:fs.npcs.split('\n').map(s=>s.trim()).filter(Boolean),connections:fs.conns,image:fs.image};
  if (locId) { const loc=world.locations.find(l=>l.id===locId); if (loc) Object.assign(loc,data); }
  else { const id=`loc_${Date.now()}`; world.locations.push({id,...data}); if (!world.currentLocationId) world.currentLocationId=id; }
  saveWorld(world); showToast('✓ Сохранено'); refreshMain();
}

// ══════════════════════════════════════════════════════════
//  ПОПАПЫ — ПЕРСОНАЖ РЕДАКТОР
// ══════════════════════════════════════════════════════════

async function openCharEditorPopup(charId) {
  const world=getWorld(), char=charId?world.characters.find(c=>c.id===charId):null, isUser=char?.id==='u_user';
  const fs={icon:char?.icon||'🧑',color:char?.color||'#7bbde8',name:char?.name||'',type:char?.type||'npc',locId:char?.locationId||'',avatar:char?.avatar||null};
  const popup=new Popup(buildCharEditorHTML(charId),POPUP_TYPE.CONFIRM,'',{okButton:char?'💾 Сохранить':'➕ Добавить',cancelButton:'Отмена'});

  requestAnimationFrame(()=>{
    wireIcons('.sa-icon-opt',v=>{fs.icon=v;});
    wireColors('.sa-color-opt',v=>{fs.color=v;});
    wireInput('sa-ch-name','name',fs); wireSelect('sa-ch-type','type',fs); wireSelect('sa-ch-loc','locId',fs);

    function bindAvArea(area) {
      area.querySelector('#sa-avatar-pick')?.addEventListener('click',()=>{
        pickImage(data=>{
          fs.avatar=data;
          area.innerHTML=`<div class="sa-avatar-preview-wrap"><img class="sa-avatar sa-avatar-img" src="${data}" style="width:64px;height:64px;border:2px solid ${fs.color}"><div class="sa-avatar-btns"><button type="button" class="sa-avatar-upload-btn" id="sa-avatar-pick"><i class="fa-solid fa-camera"></i> Сменить</button><button type="button" class="sa-avatar-remove-btn" id="sa-avatar-remove">✕ Удалить</button></div></div>`;
          bindAvArea(area);
        });
      });
      area.querySelector('#sa-avatar-remove')?.addEventListener('click',()=>{
        fs.avatar=null;
        const init=(fs.name||'?')[0]?.toUpperCase()||'?';
        area.innerHTML=`<div class="sa-avatar-preview-wrap"><div class="sa-avatar sa-avatar-initial" style="width:64px;height:64px;background:${fs.color}22;border:2px solid ${fs.color};color:${fs.color};font-size:28px">${init}</div><div class="sa-avatar-btns"><button type="button" class="sa-avatar-upload-btn" id="sa-avatar-pick"><i class="fa-solid fa-camera"></i> Загрузить фото</button></div></div>`;
        bindAvArea(area);
      });
    }
    const avArea=document.getElementById('sa-char-avatar-area'); if (avArea) bindAvArea(avArea);

    document.getElementById('sa-ch-delete')?.addEventListener('click',()=>{
      popup.complete(null);
      if (!confirm(`Удалить «${char.name}»?`)) return;
      world.characters=world.characters.filter(c=>c.id!==charId);
      saveWorld(world); showToast('✓ Удалён'); refreshMain();
    });
  });

  const result=await popup.show(); if (!result) return;
  if (!isUser&&!fs.name.trim()) { showToast('✗ Введите имя',true); return; }
  if (charId) {
    const c=world.characters.find(c=>c.id===charId);
    if (c) { c.icon=fs.icon; c.color=fs.color; c.locationId=fs.locId||null; c.avatar=fs.avatar; if(!isUser){c.name=fs.name.trim();c.type=fs.type;} }
  } else {
    world.characters.push({id:`ch_${Date.now()}`,name:fs.name.trim(),icon:fs.icon,type:fs.type,locationId:fs.locId||null,color:fs.color,avatar:fs.avatar});
  }
  saveWorld(world); showToast('✓ Сохранено'); refreshMain();
}

async function openHomeEditorPopup(charId) {
  const world=getWorld(), char=world.characters.find(c=>c.id===charId); if (!char) return;
  const fs={icon:char?.home?.icon||'🏠',name:char?.home?.name||'',desc:char?.home?.description||''};
  const popup=new Popup(buildHomeEditorHTML(charId),POPUP_TYPE.CONFIRM,'',{okButton:'💾 Сохранить',cancelButton:'Отмена'});
  requestAnimationFrame(()=>{wireIcons('.sa-icon-opt',v=>{fs.icon=v;}); wireInput('sa-hm-name','name',fs); wireInput('sa-hm-desc','desc',fs);});
  const result=await popup.show(); if (!result) return;
  if (!char.home) char.home={rooms:[]};
  char.home.icon=fs.icon; char.home.name=fs.name.trim(); char.home.description=fs.desc.trim();
  saveWorld(world); showToast('✓ Жилище сохранено'); refreshMain();
}

async function openRoomEditorPopup(charId, roomId) {
  const world=getWorld(), char=world.characters.find(c=>c.id===charId); if (!char) return;
  if (!char.home) char.home={icon:'🏠',name:'',description:'',rooms:[]};
  const room=roomId?char.home.rooms?.find(r=>r.id===roomId):null;
  const fs={icon:room?.icon||'🚪',name:room?.name||'',desc:room?.description||'',items:(room?.items||[]).join('\n')};
  const popup=new Popup(buildRoomEditorHTML(charId,roomId),POPUP_TYPE.CONFIRM,'',{okButton:roomId?'💾 Сохранить':'➕ Добавить',cancelButton:'Отмена'});
  requestAnimationFrame(()=>{
    wireIcons('.sa-icon-opt',v=>{fs.icon=v;}); wireInput('sa-rm-name','name',fs); wireInput('sa-rm-desc','desc',fs); wireInput('sa-rm-items','items',fs);
    document.getElementById('sa-rm-delete')?.addEventListener('click',()=>{popup.complete(null);if(!confirm('Удалить?'))return;char.home.rooms=(char.home.rooms||[]).filter(r=>r.id!==roomId);saveWorld(world);showToast('✓ Удалена');refreshMain();});
  });
  const result=await popup.show(); if (!result) return;
  if (!fs.name.trim()) { showToast('✗ Введите название',true); return; }
  const rData={icon:fs.icon,name:fs.name.trim(),description:fs.desc.trim(),items:fs.items.split('\n').map(s=>s.trim()).filter(Boolean)};
  if (room) Object.assign(room,rData);
  else { char.home.rooms=char.home.rooms||[]; char.home.rooms.push({id:`room_${Date.now()}`,...rData}); }
  saveWorld(world); showToast('✓ Сохранено'); refreshMain();
}

async function openLocationPopup(locId) {
  const world=getWorld();
  const popup=new Popup(buildLocationHTML(locId),POPUP_TYPE.TEXT,'',{wide:false,allowVerticalScrolling:true});
  requestAnimationFrame(()=>{
    document.querySelectorAll('#sa-conn-list .sa-conn-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{world.currentLocationId=btn.dataset.goto;saveWorld(world);applyLocationWallpaper(world);popup.complete(true);showToast('📍 '+(world.locations.find(l=>l.id===btn.dataset.goto)?.name||''));});
    });
    document.querySelectorAll('.sa-move-btn:not([disabled])').forEach(btn=>{
      btn.addEventListener('click',()=>{const ch=world.characters.find(c=>c.id===btn.dataset.charid);if(ch){ch.locationId=locId;saveWorld(world);popup.complete(true);showToast(`✓ ${ch.name==='{{user}}'?getUserName():ch.name} перемещён`);setTimeout(()=>openLocationPopup(locId),80);}});
    });
    document.getElementById('sa-set-current')?.addEventListener('click',e=>{world.currentLocationId=e.currentTarget.dataset.locid;saveWorld(world);applyLocationWallpaper(world);popup.complete(true);showToast('📍 Текущая локация обновлена');});
  });
  await popup.show(); updateBadge();
}

// ══════════════════════════════════════════════════════════
//  ГЛАВНЫЙ ПОПАП
// ══════════════════════════════════════════════════════════

let currentMainPopup=null;
async function showMainPopup() {
  currentMainPopup=new Popup(buildMainHTML(),POPUP_TYPE.TEXT,'',{wide:true,allowVerticalScrolling:true});
  requestAnimationFrame(()=>bindMainEvents());
  await currentMainPopup.show();
  currentMainPopup=null; updateBadge();
}

function bindMainEvents() {
  document.querySelectorAll('.sa-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.sa-tab').forEach(t=>t.classList.remove('sa-tab-on'));
      document.querySelectorAll('.sa-tab-pane').forEach(p=>{p.style.display='none';});
      tab.classList.add('sa-tab-on');
      document.getElementById(`sa-tab-${tab.dataset.tab}`).style.display='';
      _activeTab=tab.dataset.tab;
    });
  });
  document.querySelectorAll('.sa-tile').forEach(tile=>{tile.addEventListener('click',e=>{if(e.target.closest('.sa-tile-edit-btn'))return;openLocationPopup(tile.dataset.locid);});});
  document.querySelectorAll('.sa-tile-edit-btn').forEach(btn=>{btn.addEventListener('click',e=>{e.stopPropagation();openLocationEditorPopup(btn.dataset.editid);});});
  document.getElementById('sa-btn-add-loc')?.addEventListener('click',()=>openLocationEditorPopup(null));
  document.getElementById('sa-add-char')?.addEventListener('click',()=>openCharEditorPopup(null));
  document.querySelectorAll('.sa-char-edit-btn').forEach(btn=>{btn.addEventListener('click',()=>openCharEditorPopup(btn.dataset.charid));});
  document.querySelectorAll('.sa-char-del-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{const world=getWorld(),char=world.characters.find(c=>c.id===btn.dataset.charid);if(!char||!confirm(`Удалить «${char.name}»?`))return;world.characters=world.characters.filter(c=>c.id!==btn.dataset.charid);saveWorld(world);showToast('✓ Удалён');refreshMain();});
  });
  // Клик по аватару — сразу сменить фото
  document.querySelectorAll('.sa-char-avatar-wrap').forEach(wrap=>{
    wrap.addEventListener('click',()=>{
      const world=getWorld(),char=world.characters.find(c=>c.id===wrap.dataset.charavatarid);if(!char)return;
      pickImage(data=>{char.avatar=data;saveWorld(world);showToast('✓ Фото обновлено');refreshMain();});
    });
  });
  document.querySelectorAll('.sa-home-edit-btn').forEach(btn=>{btn.addEventListener('click',()=>openHomeEditorPopup(btn.dataset.charid));});
  document.querySelectorAll('.sa-add-room-btn').forEach(btn=>{btn.addEventListener('click',()=>openRoomEditorPopup(btn.dataset.charid,null));});
  document.querySelectorAll('.sa-room-edit-btn').forEach(btn=>{btn.addEventListener('click',()=>openRoomEditorPopup(btn.dataset.charid,btn.dataset.roomid));});

  // Генерация жилищ — все сразу
  document.getElementById('sa-btn-gen-homes')?.addEventListener('click', async () => {
    const btn = document.getElementById('sa-btn-gen-homes');
    if (!btn || btn.disabled) return;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    showToast('⏳ Генерирую жилища...');
    try {
      const { homes, targets } = await generateHomes();
      const world = getWorld();
      for (const h of homes) {
        const char = targets.find(c => {
          const n = c.name === '{{user}}' ? getUserName() : c.name;
          return n.toLowerCase() === h.characterName?.toLowerCase();
        });
        if (char && h.home) {
          const rooms = (h.home.rooms || []).map((r, i) => ({
            id: `room_${Date.now()}_${i}`,
            icon: r.icon || '🚪',
            name: r.name || 'Комната',
            description: r.description || '',
            items: r.items || [],
          }));
          char.home = {
            icon: h.home.icon || '🏠',
            name: h.home.name || 'Дом',
            description: h.home.description || '',
            rooms,
          };
        }
      }
      saveWorld(world);
      showToast(`✓ Жилища сгенерированы (${homes.length})`);
      refreshMain();
    } catch(e) {
      console.error('[СораАтлас homes]', e);
      showToast(`✗ ${e.message}`, true);
    } finally {
      const b = document.getElementById('sa-btn-gen-homes');
      if (b) { b.disabled = false; b.innerHTML = '<i class="fa-solid fa-wand-sparkles"></i> Сгенерировать'; }
    }
  });

  // Генерация жилища для одного персонажа
  document.querySelectorAll('.sa-home-gen-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      try {
        const { homes, targets } = await generateHomes([btn.dataset.charid]);
        const world = getWorld();
        for (const h of homes) {
          const char = targets.find(c => c.id === btn.dataset.charid);
          if (char && h.home) {
            char.home = {
              icon: h.home.icon || '🏠',
              name: h.home.name || 'Дом',
              description: h.home.description || '',
              rooms: (h.home.rooms||[]).map((r,i) => ({id:`room_${Date.now()}_${i}`,icon:r.icon||'🚪',name:r.name||'Комната',description:r.description||'',items:r.items||[]})),
            };
          }
        }
        saveWorld(world); showToast('✓ Жилище создано'); refreshMain();
      } catch(e) { showToast(`✗ ${e.message}`, true); btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-wand-sparkles"></i>'; }
    });
  });
  document.getElementById('sa-inject-toggle')?.addEventListener('change',e=>{saveSetting('enabled',e.target.checked);e.target.nextElementSibling?.classList.toggle('sa-tog-on',e.target.checked);showToast(e.target.checked?'✓ Инъекция включена':'✓ Инъекция выключена');});
  document.getElementById('sa-btn-clear')?.addEventListener('click',()=>{if(!confirm('Удалить карту мира?'))return;delete getSettings().worlds[getChatId()];saveSettingsDebounced();showToast('✓ Карта удалена');refreshMain();});

  document.getElementById('sa-btn-generate')?.addEventListener('click',async()=>{
    const btn=document.getElementById('sa-btn-generate');if(!btn||btn.disabled)return;
    btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i>';showToast('⏳ Генерирую мир...');
    try {
      const raw=await generateWorld(),world=getWorld(),defLoc=raw.locations.find(l=>l.isDefault)||raw.locations[0];
      world.locations=raw.locations;world.worldDescription=raw.worldDescription||'';world.currentLocationId=defLoc?.id||raw.locations[0]?.id;
      const newChars=(raw.characters||[]).map((c,i)=>({id:`ch_${Date.now()}_${i}`,name:c.name,icon:c.icon||'🧑',type:c.type||'npc',locationId:c.locationId||null,color:c.color||CHAR_COLORS[i%CHAR_COLORS.length]}));
      if (!newChars.find(c=>c.type==='user')) newChars.unshift({id:'u_user',name:'{{user}}',icon:'🧑',type:'user',locationId:world.currentLocationId,color:'#a78bfa'});
      else { const u=newChars.find(c=>c.type==='user');if(u){u.id='u_user';u.name='{{user}}';} }
      world.characters=newChars;saveWorld(world);applyLocationWallpaper(world);
      showToast(`✓ Мир создан — ${raw.locations.length} локаций`);refreshMain();
    } catch(e) { console.error('[СораАтлас]',e);showToast(`✗ ${e.message}`,true);if(btn){btn.disabled=false;btn.innerHTML='<i class="fa-solid fa-wand-sparkles"></i>';} }
  });

  const apiMap={'sa-s-url':'api_url','sa-s-key':'api_key','sa-s-model':'model','sa-s-lang':'lang'};
  for (const [id,key] of Object.entries(apiMap)) {
    const el=document.getElementById(id);if(!el)continue;
    el.addEventListener(el.tagName==='SELECT'?'change':'input',()=>{saveSetting(key,el.value);if(key==='api_key'){const st=document.getElementById('sa-key-status');if(st)st.innerHTML=el.value.trim()?'<span class="sa-key-ok">✓ ключ задан</span>':'<span class="sa-key-empty">ключ не задан</span>';}});
  }
  document.getElementById('sa-key-eye')?.addEventListener('click',()=>{const inp=document.getElementById('sa-s-key');if(!inp)return;inp.type=inp.type==='password'?'text':'password';document.querySelector('#sa-key-eye i').className=inp.type==='password'?'fa-solid fa-eye':'fa-solid fa-eye-slash';});
  document.getElementById('sa-auto-wallpaper')?.addEventListener('change',e=>{saveSetting('autoWallpaper',e.target.checked);if(!e.target.checked)restoreWallpaper();else applyLocationWallpaper(getWorld());showToast(e.target.checked?'✓ Авто-обои включены':'✓ Авто-обои выключены');});
  document.getElementById('sa-auto-track')?.addEventListener('change',e=>{saveSetting('autoTrackMovement',e.target.checked);showToast(e.target.checked?'✓ Трекинг движений включён':'✓ Трекинг выключен');});
  document.getElementById('sa-inject-home')?.addEventListener('change',e=>{saveSetting('injectHome',e.target.checked);showToast(e.target.checked?'✓ Жилище в инжекте':'✓ Жилище убрано из инжекта');});
  document.getElementById('sa-ctx-messages')?.addEventListener('change',e=>{saveSetting('contextMessages',Math.max(1,Math.min(50,Number(e.target.value)||15)));});

  const genMap={'sa-gen-sysprompt':'systemPrompt','sa-gen-loccount':'locationCount','sa-gen-npccount':'npcCount','sa-gen-wish':'userWish'};
  for (const [id,key] of Object.entries(genMap)) {
    const el=document.getElementById(id);if(!el)continue;
    el.addEventListener('input',()=>saveGenSetting(key,el.type==='number'?Number(el.value):el.value));
  }
  const genChecks={'sa-gen-card':'includeCard','sa-gen-lorebook':'includeLorebook','sa-gen-user':'includeUser','sa-gen-npcs':'generateNpcs'};
  for (const [id,key] of Object.entries(genChecks)) { const el=document.getElementById(id);if(!el)continue;el.addEventListener('change',()=>saveGenSetting(key,el.checked)); }
  document.getElementById('sa-reset-sysprompt')?.addEventListener('click',()=>{saveGenSetting('systemPrompt',DEFAULT_SYSTEM_PROMPT);const ta=document.getElementById('sa-gen-sysprompt');if(ta)ta.value=DEFAULT_SYSTEM_PROMPT;showToast('✓ Промпт сброшен');});
}

// ══════════════════════════════════════════════════════════
//  WIRE HELPERS
// ══════════════════════════════════════════════════════════

function wireInput(id,key,fs){const el=document.getElementById(id);if(!el)return;fs[key]=el.value;el.addEventListener('input',()=>{fs[key]=el.value;});el.addEventListener('change',()=>{fs[key]=el.value;});}
function wireSelect(id,key,fs){const el=document.getElementById(id);if(!el)return;fs[key]=el.value;el.addEventListener('change',()=>{fs[key]=el.value;});}
function wireIcons(sel,cb){document.querySelectorAll(sel).forEach(btn=>{if(!btn.dataset.icon)return;btn.addEventListener('click',()=>{document.querySelectorAll(sel).forEach(b=>b.classList.remove('sa-icon-opt-on'));btn.classList.add('sa-icon-opt-on');cb(btn.dataset.icon);});});}
function wireColors(sel,cb){document.querySelectorAll(sel).forEach(btn=>{if(!btn.dataset.color)return;btn.addEventListener('click',()=>{document.querySelectorAll(sel).forEach(b=>b.classList.remove('sa-color-opt-on'));btn.classList.add('sa-color-opt-on');cb(btn.dataset.color);});});}

// ══════════════════════════════════════════════════════════
//  КНОПКА В МЕНЮ + INIT
// ══════════════════════════════════════════════════════════

function createUI() {
  const item=$(`<div id="sa-menu-container" class="extension_container interactable" tabindex="0">
    <div id="sa-menu-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="СораАтлас">
      <div class="fa-solid fa-map extensionsMenuExtensionButton" style="color:#7bbde8;"></div>
      <span>СораАтлас</span>
      <span id="sa-badge" style="display:none;margin-left:6px;background:linear-gradient(135deg,#3d7fc4,#7bbde8);color:#fff;border-radius:8px;padding:0 6px;font-size:0.65rem;font-weight:700;line-height:18px;"></span>
    </div></div>`);
  const menu=$('#extensionsMenu');if(menu.length){menu.prepend(item);updateBadge();}
}

let _init=false;
function init() {
  if(_init)return; if(!document.getElementById('extensionsMenu'))return; _init=true;
  createUI(); $(document).on('click','#sa-menu-item',showMainPopup);
  const world = getWorld();
  syncUserToCurrentLocation(world);
  applyLocationWallpaper(world);
  console.log('[СораАтлас] initialized ✓');
}

jQuery(async()=>{
  getSettings();
  eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforeCombinePrompts);
  // Хук на каждое новое сообщение AI — авто-трекинг движений
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  // Хук на смену чата — обновляем обои + синхронизируем юзера
  eventSource.on(event_types.CHAT_CHANGED, () => {
    setTimeout(() => {
      const world = getWorld();
      syncUserToCurrentLocation(world);
      applyLocationWallpaper(world);
    }, 200);
  });
  eventSource.on(event_types.APP_READY, init);
  setTimeout(init, 300);
  console.log('[СораАтлас] v1.5 loaded ✓');
});
