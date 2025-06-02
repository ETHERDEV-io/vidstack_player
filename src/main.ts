import 'vidstack/player';
import 'vidstack/player/ui';
import 'vidstack/icons';

import {
  type TextTrackInit,
  type MediaRadioElement,
  type MediaPlayerElement,
  type MediaMenuElement,
  type MediaRadioGroupElement,
  type MediaCaptionsRadioGroupElement,
} from 'vidstack';

interface ServerInfo { name: string; status: string; language: string; }
interface ServersResponse { servers: ServerInfo[]; }
interface ApiSubtitleInfo { file: string; label: string; }
interface MovieStreamDetails {
  available_qualities: string[];
  has_subtitles: boolean;
  status: string;
  streams: Record<string, string>;
  subtitles: ApiSubtitleInfo[];
  title: string;
}
interface TmdbMovieInfo { title: string; original_title: string; poster_path: string | null; }

const player = document.querySelector('media-player') as MediaPlayerElement | null;
const XPRIME_BASE_API_URL = "https://backend.xprime.tv";
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = "55b4109f79eb7026ef681875b141b8e8"; // Your API Key
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/";
const LS_PLAYBACK_PREFIX = "vidstack_playbackTime_";

let allServers: ServerInfo[] = [];
let currentSelectedServerName: string | null = null;
let currentTmdbId: string | null = null;
let currentXPrimeMovieData: MovieStreamDetails | null = null;
let currentTmdbMovieData: TmdbMovieInfo | null = null;
let saveTimeInterval: number | undefined;

function savePlaybackTime(tmdbId: string, time: number) {
    if (!tmdbId || typeof time !== 'number' || isNaN(time)) return;
    try { localStorage.setItem(`${LS_PLAYBACK_PREFIX}${tmdbId}`, time.toString()); }
    catch (e) { console.warn("LS save error:", e); }
}
function getSavedPlaybackTime(tmdbId: string): number | null {
    if (!tmdbId) return null;
    try {
        const timeStr = localStorage.getItem(`${LS_PLAYBACK_PREFIX}${tmdbId}`);
        if (timeStr) { const time = parseFloat(timeStr); return !isNaN(time) && time > 0 ? time : null; }
    } catch (e) { console.warn("LS get error:", e); }
    return null;
}

function getTmdbIdFromUrl(): string | null {
  const pathParts = window.location.pathname.split('/');
  if (pathParts.length >= 3 && pathParts[pathParts.length - 2] === 'movie') return pathParts[pathParts.length - 1];
  return null;
}
function getLangCodeFromLabel(label: string): string {
  const lowerLabel = label.toLowerCase();
  const langMap: Record<string, string> = {
    "english": "en", "اَلْعَرَبِيَّةُ": "ar", "arabic": "ar", "español": "es", "spanish": "es",
    "français": "fr", "french": "fr", "বাংলা": "bn", "bengali": "bn", "filipino": "tl",
    "indonesian": "id", "ਪੰਜਾਬੀ": "pa", "punjabi": "pa", "português": "pt", "portuguese": "pt",
    "русский": "ru", "russian": "ru", "اُردُو": "ur", "urdu": "ur", "中文": "zh", "chinese": "zh",
  };
  for (const key in langMap) { if (lowerLabel.includes(key)) return langMap[key]; }
  return label.substring(0, 2).toLowerCase();
}
async function fetchTmdbMovieDetails(tmdbId: string): Promise<TmdbMovieInfo | null> {
  if (!TMDB_API_KEY) { console.error("TMDB API Key missing."); if(player) player.title = "TMDB Key Err"; return null;}
  const url = `${TMDB_API_BASE_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
  try {
    const response = await fetch(url);
    if (!response.ok) { console.error(`TMDB fetch error: ${response.status} ${response.statusText}`); if(player)player.title = `TMDB Err ${response.status}`; return null; }
    return await response.json() as TmdbMovieInfo;
  } catch (e) { console.error("Net err TMDB:", e); if(player)player.title = "Net Err (TMDB)"; return null; }
}
async function fetchXPrimeServers(): Promise<ServerInfo[]> {
  try {
    const response = await fetch(`${XPRIME_BASE_API_URL}/servers`); if (!response.ok) {console.error(`XPrime Srv err: ${response.status}`); return [];}
    const data: ServersResponse = await response.json();
    return data.servers.filter(s => s.status === "ok");
  } catch (e) { console.error("Net err XPrime Srv:", e); return []; }
}
async function fetchXPrimeMovieStreamDetails(server: string, title: string): Promise<MovieStreamDetails | null> {
  const encTitle = encodeURIComponent(title);
  try {
    const response = await fetch(`${XPRIME_BASE_API_URL}/${server}?name=${encTitle}`); if (!response.ok) { console.error(`XPrime Details err ${server}/${title}: ${response.status}`); return null;}
    const data: MovieStreamDetails = await response.json();
    return (data.status === "ok" || (data.available_qualities && data.available_qualities.length > 0)) ? data : null;
  } catch (e) { console.error(`Net err XPrime details ${title}/${server}:`, e); return null; }
}

function updatePlayerVisuals() {
  if (!player) return;
  const posterEl = player.querySelector('media-poster') as HTMLMediaPosterElement | null;
  if (currentTmdbMovieData) {
    player.title = currentTmdbMovieData.title || currentTmdbMovieData.original_title || "Video";
    if (posterEl && currentTmdbMovieData.poster_path) posterEl.src = `${TMDB_IMAGE_BASE_URL}w780${currentTmdbMovieData.poster_path}`;
    else if (posterEl) posterEl.src = "";
  } else if (currentXPrimeMovieData) {
    player.title = currentXPrimeMovieData.title || "Video";
    if (posterEl) posterEl.src = "";
  } else { player.title = "Loading..."; if (posterEl) posterEl.src = ""; }
}

function updateRadioGroupValue(group: MediaRadioGroupElement | MediaCaptionsRadioGroupElement, value: string) {
  (group as any).value = value;
}

function populateMenuRadios(
    menuElementId: string,
    items: Array<{ label: string; value: string; flag?: string }>,
    onItemClick: (value: string, radioEl: MediaRadioElement, groupEl: MediaRadioGroupElement) => void,
    initialValue?: string
) {
    if (!player) return;
    const menu = player.querySelector(`#${menuElementId}`) as MediaMenuElement | null;
    if (!menu) { console.warn(`Menu #${menuElementId} not found.`); return; }
    const radioGroup = menu.querySelector('media-radio-group') as MediaRadioGroupElement | null; // Specific to Server/Quality
    const hint = menu.querySelector<HTMLElement>('media-menu-button [data-part="hint"]');

    if (!radioGroup || !hint) {
        console.warn(`Radio group or hint missing in #${menuElementId}.`);
        if(hint) hint.textContent = "Err"; menu.style.display = 'none'; return;
    }
    const template = radioGroup.querySelector('template');
    radioGroup.innerHTML = ''; if (template) radioGroup.appendChild(template.content.cloneNode(true));

    if (items.length === 0) { hint.textContent = "N/A"; menu.style.display = 'none'; return; }
    menu.style.display = '';

    let activeRadio: MediaRadioElement | null = null;
    items.forEach(item => {
        const radioEl = document.createElement('media-radio') as MediaRadioElement;
        radioEl.value = item.value;
        const flagHtml = item.flag ? `<img src="${item.flag}" alt="${item.label} flag" class="server-flag" />` : '';
        radioEl.innerHTML = `<div class="media-radio-check"></div>${flagHtml}<span class="media-radio-label" data-part="label">${item.label}</span>`;
        radioEl.addEventListener('click', () => onItemClick(item.value, radioEl, radioGroup));
        radioGroup.appendChild(radioEl);
        if (initialValue === item.value || (!initialValue && !activeRadio)) activeRadio = radioEl;
    });

    if (activeRadio) {
        const label = items.find(i => i.value === activeRadio!.value)?.label || activeRadio!.value;
        hint.textContent = label.substring(0, 12);
        setTimeout(() => { updateRadioGroupValue(radioGroup, activeRadio!.value); }, 0);
    } else if (items.length > 0 && hint) {
        hint.textContent = items[0].label.substring(0,12);
        setTimeout(() => { updateRadioGroupValue(radioGroup, items[0].value); }, 0);
    }
}

function setupServerMenu() {
    const serverItems = allServers.map(s => ({ label: s.name, value: s.name, flag: s.language }));
    populateMenuRadios('dynamic-server-menu', serverItems,
        async (value, radioEl, groupEl) => {
            if (currentSelectedServerName === value || !currentTmdbMovieData?.title) return;
            currentSelectedServerName = value;
            updateRadioGroupValue(groupEl, radioEl.value);
            (groupEl.closest('media-menu')?.querySelector<HTMLElement>('[data-part="hint"]'))!.textContent = value.substring(0,12);
            await loadXPrimeContent();
        }, currentSelectedServerName || (allServers.length > 0 ? allServers[0].name : undefined)
    );
}

function setupQualityMenu() {
    const qualityMenuEl = player?.querySelector('#dynamic-quality-menu') as MediaMenuElement | null;
    if (!currentXPrimeMovieData?.available_qualities || currentXPrimeMovieData.available_qualities.length === 0) {
        if(qualityMenuEl) qualityMenuEl.style.display = 'none';
        const hint = qualityMenuEl?.querySelector<HTMLElement>('media-menu-button [data-part="hint"]');
        if(hint) hint.textContent = "N/A";
        return;
    }
    if(qualityMenuEl) qualityMenuEl.style.display = '';

    const qualItems = currentXPrimeMovieData.available_qualities.map(q => ({ label: q, value: q }));
    const streams = currentXPrimeMovieData.streams;
    let currentQual = "";
    if (player?.src) { Object.entries(streams).find(([q, s]) => { if (s === player.src) currentQual = q; return s === player.src; }); }
    if (!currentQual) currentQual = qualItems.find(q => q.value === "720P")?.value || qualItems[0]?.value || "";

    populateMenuRadios('dynamic-quality-menu', qualItems,
        (value, radioEl, groupEl) => {
            const newSrc = streams[value];
            if (!player || !newSrc || player.src === newSrc) return;
            changeVideoSource(newSrc);
            updateRadioGroupValue(groupEl, radioEl.value);
            (groupEl.closest('media-menu')?.querySelector<HTMLElement>('[data-part="hint"]'))!.textContent = value;
        }, currentQual
    );
}

function setupCaptionsMenu() {
    if (!player) return;
    const captionsMenuContainer = player.querySelector('#dynamic-captions-menu') as MediaMenuElement | null;
    const mainCaptionButton = player.querySelector('media-caption-button');
    const hintElement = captionsMenuContainer?.querySelector<HTMLElement>('media-menu-button [data-part="hint"]');

    if (!captionsMenuContainer || !hintElement) { console.warn("Captions menu/hint not found."); if(mainCaptionButton)mainCaptionButton.disabled = true; return; }
    player.textTracks.clear();

    if (!currentXPrimeMovieData || !currentXPrimeMovieData.has_subtitles || !currentXPrimeMovieData.subtitles?.length) {
        if (mainCaptionButton) mainCaptionButton.disabled = true;
        captionsMenuContainer.style.display = 'none';
        hintElement.textContent = "N/A";
        return;
    }
    if (mainCaptionButton) mainCaptionButton.disabled = false;
    captionsMenuContainer.style.display = '';

    console.log("Adding text tracks:", currentXPrimeMovieData.subtitles);
    currentXPrimeMovieData.subtitles.forEach(sub => {
        const lang = getLangCodeFromLabel(sub.label);
        const isDefault = player.textTracks.length === 0 && lang === 'en'; // Make first English track default
        const trackInit: TextTrackInit = {
            src: sub.file, label: sub.label, language: lang, kind: 'subtitles', default: isDefault,
            type: sub.file.endsWith('.vtt') ? 'vtt' : (sub.file.endsWith('.srt') ? 'srt' : undefined)
        };
        try {
            player.textTracks.add(trackInit);
            console.log("Added track:", trackInit.label, "Default:", isDefault);
        } catch(e) {
            console.error("Error adding track:", trackInit.src, e);
        }
    });

    // Update hint based on currently selected track after tracks are added
    const updateCaptionHint = () => {
        const selectedTrack = player.textTracks.selected;
        hintElement.textContent = selectedTrack ? selectedTrack.label.substring(0, 12) : "Off";
    };
    player.textTracks.addEventListener('change', updateCaptionHint); // When selection actually changes
    // Initial hint based on what might be auto-selected (e.g., default track)
    setTimeout(updateCaptionHint, 100); // Small delay for tracks to settle
}


function changeVideoSource(newSrc: string) {
  if (!player) return;
  const wasPlaying = !player.paused;
  const previousTime = player.currentTime > 1 && player.currentTime < (player.duration - 2) ? player.currentTime : 0; // Store if valid

  player.src = newSrc;
  console.log(`Changing source to: ${newSrc}, wasPlaying: ${wasPlaying}, previousTime: ${previousTime}`);

  player.addEventListener('canplay', () => {
    let resumeTime = previousTime;
    if (currentTmdbId) {
        const savedTime = getSavedPlaybackTime(currentTmdbId);
        console.log(`canplay: savedTime for ${currentTmdbId} is ${savedTime}`);
        if (savedTime !== null) {
             // If a significant saved time exists, prioritize it, unless previousTime was also significant
            if (previousTime < 2 || Math.abs(savedTime - previousTime) > 5) {
                resumeTime = savedTime;
            }
        }
    }
    console.log(`canplay: Attempting to resume at ${resumeTime}`);
    if (resumeTime > 0 && resumeTime < (player.duration -1) ) { // Check against new duration
        player.currentTime = resumeTime;
    }
    if (wasPlaying) player.play().catch(e => console.warn("Resume play failed:", e));
  }, { once: true });
}

async function loadXPrimeContent() {
  if (!player || !currentSelectedServerName || !currentTmdbMovieData?.title) {
    if(player) player.title = "Error"; console.error("loadXPrime: Missing data");
    setupQualityMenu(); setupCaptionsMenu(); return;
  }
  player.classList.add('player-loading');
  currentXPrimeMovieData = await fetchXPrimeMovieStreamDetails(currentSelectedServerName, currentTmdbMovieData.title);
  player.classList.remove('player-loading');

  if (currentXPrimeMovieData?.streams && currentXPrimeMovieData.available_qualities?.length) {
    updatePlayerVisuals();
    const prefQuals = ["720P", "1080P"];
    let initQual = prefQuals.find(q => currentXPrimeMovieData!.available_qualities.includes(q)) || currentXPrimeMovieData.available_qualities[0];
    if (initQual) {
        const initSrc = currentXPrimeMovieData.streams[initQual];
        if (initSrc) changeVideoSource(initSrc);
        else { console.error("No stream for quality:", initQual); player.title = "Stream Err"; }
    } else { console.error("No initial quality."); player.title = "Quality Err"; }
  } else {
    player.title = `Content unavailable on ${currentSelectedServerName || 'server'}`;
    console.error(`XPrime fetch error for "${currentTmdbMovieData.title}" on ${currentSelectedServerName}`);
  }
  setupQualityMenu();
  setupCaptionsMenu(); // This will now correctly process new tracks
}

async function initializeApp() {
  if (!player) { console.error("Player element not found!"); return; }
  player.addEventListener('pause', () => {
    if (currentTmdbId && player.currentTime > 1 && player.duration && player.currentTime < player.duration - 2) {
      savePlaybackTime(currentTmdbId, player.currentTime);
    }
  });
  player.addEventListener('ended', () => { if (currentTmdbId) localStorage.removeItem(`${LS_PLAYBACK_PREFIX}${currentTmdbId}`); });
  player.addEventListener('timeupdate', () => {
    if (currentTmdbId && player.currentTime > 1 && !player.seeking && player.duration && player.currentTime < player.duration - 2) {
      if (saveTimeInterval) clearTimeout(saveTimeInterval);
      saveTimeInterval = window.setTimeout(() => { if (currentTmdbId && player.currentTime > 1) savePlaybackTime(currentTmdbId, player.currentTime); }, 3000);
    }
  });
  window.addEventListener('beforeunload', () => {
    if (player && currentTmdbId && player.currentTime > 1 && !player.paused && player.duration && player.currentTime < player.duration - 2) {
      savePlaybackTime(currentTmdbId, player.currentTime);
    }
  });

  player.classList.add('player-loading'); updatePlayerVisuals();
  currentTmdbId = getTmdbIdFromUrl();
  if (!currentTmdbId) { player.title = "No Movie ID"; player.classList.remove('player-loading'); return; }

  currentTmdbMovieData = await fetchTmdbMovieDetails(currentTmdbId);
  if (!currentTmdbMovieData) { player.classList.remove('player-loading'); return; }
  updatePlayerVisuals();

  allServers = await fetchXPrimeServers();
  if (allServers.length > 0) currentSelectedServerName = allServers[0].name;
  else console.warn("No XPrime servers.");

  setupServerMenu();
  if (currentSelectedServerName && currentTmdbMovieData?.title) {
    await loadXPrimeContent();
  } else {
    setupQualityMenu(); setupCaptionsMenu();
    if(!currentTmdbMovieData?.title && player) player.title = "Title Missing";
    else if(allServers.length === 0 && player) player.title = "No Servers";
    player.classList.remove('player-loading');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeApp);
else initializeApp();
