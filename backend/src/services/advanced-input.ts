export const ADVANCED_ENGINES = [
  'ripme', 'wget', 'httrack', 'coursera-dl', 'udemy-downloader', 'curs-dl',
  'streamrip', 'openaudible', 'libgen', 'annas-mcp', 'scihub', 'spotdl',
] as const;
export type EngineName = typeof ADVANCED_ENGINES[number];
export type EngineSelection = { engine: Exclude<EngineName, 'curs-dl'>; value: string };

const matches = (host: string, suffix: string) => host === suffix || host.endsWith('.' + suffix);
const knownMirrors = /^(?:www\.)?annas-archive\.(?:gl|li|se|org|in|pm|gs|gd|vg|pk|sk|st|ru)$/i;
const libgenMirrors = /^(?:www\.)?(?:libgen\.(?:is|rs|st|li|gs|bz|la|lc|gl|vg)|library\.lol)$/i;
const md5 = /^[a-f0-9]{32}$/i;
const doi = /^10\.\d{4,9}\/[a-z0-9][a-z0-9._;()/:%+-]{0,220}$/i;
const courseSlug = /^[a-z0-9][a-z0-9-]{0,127}$/;
const galleryHosts = ['imgur.com', 'deviantart.com', 'flickr.com', 'tumblr.com', 'reddit.com', 'imagebam.com',
  'imagevenue.com', 'artstation.com', 'pixiv.net', '500px.com', 'photobucket.com'];
const musicHosts = ['tidal.com', 'qobuz.com', 'deezer.com', 'soundcloud.com', 'bandcamp.com'];
const audioBookHosts = ['audible.com', 'audible.co.uk', 'audible.ca', 'audible.de', 'audible.fr', 'audible.com.au', 'audible.in'];

function parseWebUrl(value: string): URL | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.port) throw new Error('Use a web URL without credentials or a custom port.');
  url.hash = '';
  return url;
}

export function selectAdvancedEngine(input: string, requested?: EngineName | 'auto'): EngineSelection {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a valid link or identifier.');
  const url = parseWebUrl(value);
  const host = url?.hostname.toLowerCase() || '';
  const pathname = url?.pathname || '';
  let engine = requested === 'auto' ? undefined : requested;
  if (!engine || engine === 'curs-dl') {
    if (matches(host, 'coursera.org')) engine = 'coursera-dl';
    else if (matches(host, 'udemy.com')) engine = 'udemy-downloader';
    else if (engine === 'curs-dl') throw new Error('The course route accepts a Coursera or Udemy course link.');
    else if (host === 'open.spotify.com') engine = 'spotdl';
    else if (musicHosts.some((suffix) => matches(host, suffix))) engine = 'streamrip';
    else if (audioBookHosts.some((suffix) => matches(host, suffix))) engine = 'openaudible';
    else if (knownMirrors.test(host)) engine = 'annas-mcp';
    else if (libgenMirrors.test(host)) engine = 'libgen';
    else if (host === 'doi.org' || /^(?:www\.)?sci-hub\.[a-z]+$/.test(host) || doi.test(value)) engine = 'scihub';
    else if (galleryHosts.some((suffix) => matches(host, suffix))) engine = 'ripme';
    else throw new Error('No automatic route matches this input. Choose Wget or HTTrack explicitly to mirror a site.');
  }

  switch (engine) {
    case 'wget': case 'httrack':
      if (url) return { engine, value: url.href };
      break;
    case 'ripme':
      if (url && galleryHosts.some((suffix) => matches(host, suffix))) return { engine, value: url.href };
      break;
    case 'spotdl': {
      const id = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?$/i.exec(pathname);
      if (host === 'open.spotify.com' && id) return { engine, value: `https://open.spotify.com/${id[1].toLowerCase()}/${id[2]}` };
      break;
    }
    case 'streamrip':
      if (url && musicHosts.some((suffix) => matches(host, suffix))) return { engine, value: url.href };
      break;
    case 'coursera-dl': {
      const slug = matches(host, 'coursera.org') ? /^\/(?:learn|course)\/([a-z0-9-]+)(?:\/|$)/.exec(pathname)?.[1] : (!url ? value : '');
      if (slug && courseSlug.test(slug)) return { engine, value: slug };
      break;
    }
    case 'udemy-downloader': {
      const slug = matches(host, 'udemy.com') ? /^\/course\/([a-z0-9-]+)(?:\/|$)/.exec(pathname)?.[1] : '';
      if (slug && courseSlug.test(slug)) return { engine, value: 'https://' + host + '/course/' + slug + '/' };
      break;
    }
    case 'openaudible': {
      const asin = audioBookHosts.some((suffix) => matches(host, suffix))
        ? /(?:^|\/)([A-Z0-9]{10})\/?$/i.exec(pathname)?.[1] : undefined;
      if (asin) return { engine, value: asin.toUpperCase() };
      if (!url && /^(?:[a-z0-9]{10}|[^/\\:*?"<>|]{1,170}\.(?:mp3|m4a|m4b|aac|flac|opus|wav))$/i.test(value) && !value.startsWith('.')) {
        return { engine, value };
      }
      break;
    }
    case 'libgen': case 'annas-mcp': {
      const acceptedHost = engine === 'libgen' ? libgenMirrors : knownMirrors;
      const hash = !url ? value : acceptedHost.test(host)
        ? url.searchParams.get('md5') || /(?:^|\/)([a-f0-9]{32})\/?$/i.exec(pathname)?.[1] || '' : '';
      if (md5.test(hash)) return { engine, value: hash.toLowerCase() };
      break;
    }
    case 'scihub': {
      const acceptedHost = host === 'doi.org' || /^(?:www\.)?sci-hub\.[a-z]+$/.test(host);
      const identifier = url && acceptedHost ? decodeURIComponent(pathname.slice(1)) : !url ? value : '';
      if (doi.test(identifier) || /^\d{5,10}$/.test(identifier)) return { engine, value: identifier };
      break;
    }
  }
  throw new Error('The link or identifier does not match this engine.');
}
