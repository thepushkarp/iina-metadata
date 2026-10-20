(() => {
  // src/http.ts
  class HttpError extends Error {
    status;
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  var iinaGetJson = async (url, params = {}, headers = {}) => {
    const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    const describe = `GET ${url}${query ? "?" + query : ""}`;
    let res;
    try {
      res = await iina.http.get(url, { params, headers, data: {} });
    } catch (error) {
      const failed = error;
      const status = typeof failed?.statusCode === "number" ? failed.statusCode : undefined;
      const reason = failed?.reason ?? String(error);
      throw new HttpError(status, `${describe} failed: ${status ?? "network error"} ${reason}`);
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new HttpError(res.statusCode, `${describe} returned invalid JSON`);
    }
  };
  function isNotFound(error) {
    return error instanceof HttpError && error.status === 404;
  }

  // src/match.ts
  var HIGH_SCORE = 0.85;
  var HIGH_MARGIN = 0.08;
  function rank(query, candidates) {
    return candidates.map((candidate) => ({ candidate, score: score(query, candidate) })).sort((a, b) => b.score - a.score);
  }
  function confidenceOf(ranked) {
    const [best, second] = ranked;
    if (!best)
      return;
    const clear = !second || best.score - second.score >= HIGH_MARGIN;
    return best.score >= HIGH_SCORE && clear ? "high" : "low";
  }
  function score(query, candidate) {
    const titleScore = Math.max(similarity(query.title, candidate.title), candidate.originalTitle ? similarity(query.title, candidate.originalTitle) : 0);
    let yearScore = 0.5;
    if (query.year && candidate.year) {
      const diff = Math.abs(query.year - candidate.year);
      yearScore = diff === 0 ? 1 : diff === 1 ? 0.6 : 0;
    }
    const popularity = Math.min(Math.log10(1 + (candidate.popularity ?? 0)) / 3, 1) * 0.03;
    return titleScore * 0.75 + yearScore * 0.25 + popularity;
  }
  function normalizeTitle(text) {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
  }
  function similarity(a, b) {
    const x = normalizeTitle(a);
    const y = normalizeTitle(b);
    if (x === y)
      return 1;
    if (x.length < 2 || y.length < 2)
      return 0;
    const grams = new Map;
    for (let i = 0;i < x.length - 1; i++) {
      const gram = x.slice(i, i + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    let shared = 0;
    for (let i = 0;i < y.length - 1; i++) {
      const gram = y.slice(i, i + 2);
      const count = grams.get(gram) ?? 0;
      if (count > 0) {
        grams.set(gram, count - 1);
        shared++;
      }
    }
    return 2 * shared / (x.length - 1 + (y.length - 1));
  }

  // src/identify.ts
  class NeedsTokenError extends Error {
    constructor(what) {
      super(`${what} needs a TMDB token. Add one in the Metadata sidebar.`);
    }
  }
  async function identify(query, providers, hints) {
    const matched = async (ref, confidence, via, candidates = []) => ({ status: "matched", metadata: await fetchMetadata(ref, providers), ref, confidence, via, candidates });
    const known = [
      ["remembered match", async () => hints.remembered],
      ["embedded id", async () => hints.embedded],
      ["id in filename", () => refFromIds(query, providers)]
    ];
    for (const [via, lookup] of known) {
      const ref = await lookup();
      if (!ref || ref.provider === "tmdb" && !providers.tmdb)
        continue;
      const located = withEpisode(ref, query);
      if (located)
        return matched(located, "high", via);
    }
    if (!query.title)
      return { status: "unmatched", reason: "Couldn't read a title from the file name.", candidates: [] };
    const ranked = rank(query, await search(query.kind, query.title, query.year, providers));
    const candidates = ranked.map((entry) => entry.candidate);
    const best = candidates[0];
    if (!best)
      return { status: "unmatched", reason: `Nothing found for "${query.title}".`, candidates };
    const ref = withEpisode({ provider: best.provider, kind: best.kind, id: best.id }, query);
    if (!ref)
      return { status: "unmatched", reason: "Season and episode numbers are missing.", candidates };
    return matched(ref, confidenceOf(ranked), "search", candidates);
  }
  async function search(kind, title, year, providers) {
    const { tmdb, tvmaze } = providers;
    if (!tmdb && kind === "movie")
      throw new NeedsTokenError("Looking up movies");
    if (tmdb) {
      let results = await tmdb.search(kind, title, year);
      if (results.length === 0 && year)
        results = await tmdb.search(kind, title);
      if (results.length > 0 || kind === "movie")
        return results;
    }
    return tvmaze.searchShows(title);
  }
  async function fetchMetadata(ref, providers) {
    if (ref.provider === "tvmaze")
      return providers.tvmaze.episode(ref.id, ref.season, ref.episodes);
    const { tmdb } = providers;
    if (!tmdb)
      throw new NeedsTokenError("This TMDB match");
    if (ref.kind === "movie")
      return tmdb.movie(ref.id);
    return tmdb.episode(ref.id, ref.season, ref.episodes);
  }
  function withEpisode(ref, query) {
    if (ref.kind === "movie")
      return { provider: ref.provider, kind: "movie", id: ref.id };
    const season = query.season ?? ref.season;
    const episodes = query.episodes.length > 0 ? query.episodes : ref.episodes;
    if (season === undefined || !episodes || episodes.length === 0)
      return;
    return { ...ref, season, episodes };
  }
  async function refFromIds(query, providers) {
    const { ids, kind } = query;
    const { tmdb, tvmaze } = providers;
    if (ids.tmdb)
      return { provider: "tmdb", kind, id: ids.tmdb };
    if (!ids.imdb && !ids.tvdb)
      return;
    if (tmdb) {
      const found = ids.imdb ? await tmdb.find("imdb_id", ids.imdb) : await tmdb.find("tvdb_id", String(ids.tvdb));
      const id = kind === "movie" ? found.movie : found.show;
      if (id)
        return { provider: "tmdb", kind, id };
    }
    if (kind === "episode") {
      const id = ids.imdb ? await tvmaze.lookup("imdb", ids.imdb) : await tvmaze.lookup("thetvdb", String(ids.tvdb));
      if (id)
        return { provider: "tvmaze", kind, id };
    }
    return;
  }

  // src/model.ts
  function displayTitle(meta) {
    if (meta.kind === "movie")
      return meta.year ? `${meta.title} (${meta.year})` : meta.title;
    return `${meta.show.title} – ${episodeCode(meta.season, meta.episodes)} – ${meta.title}`;
  }
  function episodeCode(season, episodes) {
    const pad = (n) => String(n).padStart(2, "0");
    return `S${pad(season)}` + episodes.map((e) => `E${pad(e)}`).join("");
  }
  function tmdbTag(meta) {
    if (meta.provider !== "tmdb")
      return;
    return meta.kind === "movie" ? `movie/${meta.ids.tmdb}` : `tv/${meta.show.ids.tmdb}`;
  }
  function parseTmdbTag(value) {
    const match = /^(movie|tv)\/(\d+)$/.exec((value ?? "").trim());
    if (!match)
      return;
    return { provider: "tmdb", kind: match[1] === "movie" ? "movie" : "episode", id: Number(match[2]) };
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/audioChannels.js
  var Channels;
  (function(Channels) {
    Channels["SEVEN"] = "7.1";
    Channels["SIX"] = "5.1";
    Channels["STEREO"] = "stereo";
    Channels["MONO"] = "mono";
  })(Channels || (Channels = {}));
  var channelPatterns = [
    { channels: Channels.SEVEN, regex: /(?<!\d)7[\W_][01]\b/i },
    {
      channels: Channels.SIX,
      regex: /(?<!\d)((6[\W]0(?:ch)?)(?=[^\d]|$)|(5[\W][01](?:ch)?)(?=[^\d]|$)|5ch|6ch)\b/i
    },
    { channels: Channels.STEREO, regex: /(?<!\d)(2[\W]0(?:ch)?)(?=[^\d]|$)|\bstereo\b/i },
    { channels: Channels.MONO, regex: /(?<!\d)(1[\W]0(?:ch)?)(?=[^\d]|$)|\b(?:mono|1ch)\b/i }
  ];
  var channelCandidateExp = /(?:^|[^\d])(?:7[\W_][01]|[56](?:[\W][01]|ch)|2[\W]0|1(?:[\W]0|ch)|stereo|mono)/i;
  function parseAudioChannels(title) {
    if (!channelCandidateExp.test(title)) {
      return {};
    }
    for (const { channels, regex } of channelPatterns) {
      const match = regex.exec(title);
      if (match) {
        return { channels, source: match[0] };
      }
    }
    return {};
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/audioCodec.js
  var AudioCodec;
  (function(AudioCodec) {
    AudioCodec["MP3"] = "MP3";
    AudioCodec["MP2"] = "MP2";
    AudioCodec["DOLBY"] = "Dolby Digital";
    AudioCodec["EAC3"] = "Dolby Digital Plus";
    AudioCodec["AAC"] = "AAC";
    AudioCodec["FLAC"] = "FLAC";
    AudioCodec["DTS"] = "DTS";
    AudioCodec["DTSHD"] = "DTS-HD";
    AudioCodec["TRUEHD"] = "Dolby TrueHD";
    AudioCodec["OPUS"] = "Opus";
    AudioCodec["VORBIS"] = "Vorbis";
    AudioCodec["PCM"] = "PCM";
    AudioCodec["LPCM"] = "LPCM";
  })(AudioCodec || (AudioCodec = {}));
  var audioCodecPatterns = [
    { name: "dolby-atmos", codec: AudioCodec.EAC3, regex: /\bDolby[-_. ]?Atmos\b/i },
    {
      name: "eac3",
      codec: AudioCodec.EAC3,
      regex: /\b(?:E-?AC-?3|DDP(?:\d(?:[.\s-]?\d)?)?|DD\+)\b/i
    },
    { name: "truehd", codec: AudioCodec.TRUEHD, regex: /\bTrue-?HD\b/i },
    {
      name: "dolby",
      codec: AudioCodec.DOLBY,
      regex: /\b(?:Dolby-?Digital|Dolby|DD(?:\d(?:[.\s-]?\d)?)?|AC-?3D?)\b/i
    },
    { name: "dts-hd", codec: AudioCodec.DTSHD, regex: /\b(?:DTS-?HD|DTS-?MA|DTS[-.: ]?X)\b/i },
    { name: "dts", codec: AudioCodec.DTS, regex: /\bDTS\b/i },
    { name: "aac", codec: AudioCodec.AAC, regex: /\bAAC(?=(?:\d(?:[.\s]?\d)?)?(?:ch)?\b)/i },
    { name: "flac", codec: AudioCodec.FLAC, regex: /\bFLAC\b/i },
    { name: "mp3", codec: AudioCodec.MP3, regex: /\b(?:LAME(?:\d)+-?(?:\d)+|mp3)\b/i },
    { name: "mp2", codec: AudioCodec.MP2, regex: /\bmp2\b/i },
    { name: "lpcm", codec: AudioCodec.LPCM, regex: /\bLPCM\b/i },
    { name: "pcm", codec: AudioCodec.PCM, regex: /\bPCM\b/i },
    { name: "opus", codec: AudioCodec.OPUS, regex: /\bOpus\b/i },
    { name: "vorbis", codec: AudioCodec.VORBIS, regex: /\bVorbis\b/i }
  ];
  function parseAudioCodec(title) {
    for (const { codec, regex } of audioCodecPatterns) {
      const result = regex.exec(title);
      if (result) {
        return { codec, source: result[0] };
      }
    }
    return {};
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/videoCodec.js
  var VideoCodec;
  (function(VideoCodec) {
    VideoCodec["X265"] = "x265";
    VideoCodec["X264"] = "x264";
    VideoCodec["H264"] = "h264";
    VideoCodec["H265"] = "h265";
    VideoCodec["WMV"] = "WMV";
    VideoCodec["XVID"] = "xvid";
    VideoCodec["DVDR"] = "dvdr";
    VideoCodec["AV1"] = "av1";
    VideoCodec["VP9"] = "vp9";
  })(VideoCodec || (VideoCodec = {}));
  var codecPatterns = [
    { codec: VideoCodec.H264, regex: /h[-_. ]?264/i },
    { codec: VideoCodec.H265, regex: /h[-_. ]?265/i },
    { codec: VideoCodec.X265, regex: /x265|HEVC/i },
    { codec: VideoCodec.X264, regex: /x264/i },
    { codec: VideoCodec.XVID, regex: /XvidHD|X-?vid|divx/i },
    { codec: VideoCodec.WMV, regex: /WMV/i },
    { codec: VideoCodec.DVDR, regex: /DVDR\b/i },
    { codec: VideoCodec.AV1, regex: /\bAV1\b/i },
    { codec: VideoCodec.VP9, regex: /\bVP9\b/i },
    { codec: VideoCodec.H264, regex: /\bAVC\b/i }
  ];
  var codecExp = new RegExp(codecPatterns.map(({ regex }) => regex.source).join("|"), "i");
  function parseVideoCodec(title) {
    for (const { codec, regex } of codecPatterns) {
      const match = regex.exec(title);
      if (match) {
        return { codec, source: match[0] };
      }
    }
    return {};
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/website.js
  var domainExp = String.raw`(?:www\.)?[-a-z0-9-]{1,256}\.(?<!Naruto-Kun\.)(?:[a-z]{2,6}\.[a-z]{2,6}|xn--[a-z0-9-]{4,59}|[a-z]{2,63})\b`;
  var websitePrefixExp = new RegExp(String.raw`^(?:(?:\[|\()[ \t]{0,32})?${domainExp}(?:[ \t]{0,32}(?:\]|\))|[ -]{2,})[ -]{0,64}`, "i");
  var websitePostfixExp = new RegExp(String.raw`(?:\[[ \t]{0,32}${domainExp}[ \t]{0,32}\]|[ -]{2,}${domainExp})$`, "i");
  var cleanTorrentSuffixExp = /\[(?:ettv|rartv|rarbg|cttv|publichd)\]$/i;
  function hasWebsitePrefix(title) {
    return mightHaveWebsitePrefix(title) && websitePrefixExp.test(title);
  }
  function removeWebsitePrefix(title) {
    return mightHaveWebsitePrefix(title) ? title.replace(websitePrefixExp, "") : title;
  }
  function mightHaveWebsitePrefix(title) {
    const first = title.charCodeAt(0);
    return first === 40 || first === 91 || lowerAsciiCode(first) === 119 || title.includes(" - ") || title.includes("--") || title.includes("  ");
  }
  function lowerAsciiCode(code) {
    return code >= 65 && code <= 90 ? code + 32 : code;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/source.js
  var blurayExp = /\b(M?Blu[-_. ]?Ray|HD[-_. ]?DVD|BD(?!$)|UHD2?BD|BDISO|BDMux|BD25|BD50|BD[-_. ]?(?:50|66|100)|BR[-_. ]?DISK|Bluray(2160|1080|720)p?|BD(2160|1080|720)p?)\b/i;
  var webdlExp = /\b(WEB[-_. ]DL(?:mux)?|HDRIP|WEBDL|NF|DP|APTV|NETFLIX|NetflixU?HD|DSNY|DSNP|DisneyHD|HMAX|HBOMaxHD|AMZN|AmazonHD|AmazonSD|iTunesHD|MaxdomeHD|WebHD\b|[. ]WEB[. ](?:[xh][ .]?26[45]|AVC|HEVC|DDP?5[. ]1)|\d{3,4}0p[-. ](?:Hybrid[-_. ]?)?WEB[-. ]|[-. ]WEB[-. ]\d{3,4}0p|\b\s\/\sWEB\s\/\s\b|(?:AMZN|NF|DP)[. -]WEB[. -](?!Rip))\b/i;
  var Source;
  (function(Source) {
    Source["BLURAY"] = "BLURAY";
    Source["WEBDL"] = "WEBDL";
    Source["WEBRIP"] = "WEBRIP";
    Source["DVD"] = "DVD";
    Source["CAM"] = "CAM";
    Source["SCREENER"] = "SCREENER";
    Source["PPV"] = "PPV";
    Source["TELESYNC"] = "TELESYNC";
    Source["TELECINE"] = "TELECINE";
    Source["WORKPRINT"] = "WORKPRINT";
    Source["TV"] = "TV";
  })(Source || (Source = {}));
  var sourceGroupPatterns = [
    { group: "bluray", regex: blurayExp },
    { group: "webdl", regex: webdlExp },
    { group: "webrip", regex: /\b(WebRip|Web-Rip|WEBCap|WEBMux)\b/i },
    { group: "hdtv", regex: /\b(HDTV|HD[-_. ]TV)\b/i },
    { group: "bdrip", regex: /\b(BDRip|BDLight|UHDBDRip|HD[-_. ]?DVDRip)\b/i },
    { group: "brrip", regex: /\b(BRRip)\b/i },
    { group: "scr", regex: /\b(SCR|SCREENER|DVDSCR|(DVD|WEB).?SCREENER)\b/i },
    { group: "dvdr", regex: /\b(DVD-R|DVDR)\b/i },
    { group: "dvd", regex: /\b(DVD9?|DVDRip|NTSC|PAL|xvidvd|DvDivX)\b/i },
    { group: "dsr", regex: /\b(WS[-_. ]DSR|DSR)\b/i },
    { group: "regional", regex: /\b(R[0-9]{1}|REGIONAL)\b/i },
    { group: "ppv", regex: /\b(PPV)\b/i },
    { group: "ts", regex: /\b(TS[-_. ]|TELESYNCH?|HD-TS|HDTS|PDVD|TSRip|HDTSRip)\b/i },
    { group: "tc", regex: /\b(TC|TELECINE|HD-TC|HDTC)\b/i },
    { group: "cam", regex: /\b(CAMRIP|(?:NEW)?CAM|HD-?CAM(?:Rip)?|HQCAM)\b/i },
    { group: "workprint", regex: /\b(WORKPRINT|WP)\b/i },
    { group: "pdtv", regex: /\b(PDTV)\b/i },
    { group: "sdtv", regex: /\b(SDTV|SD[-_. ]TV)\b/i },
    { group: "tvrip", regex: /\b(TVRip)\b/i }
  ];
  var sourcePolicies = [
    {
      source: Source.BLURAY,
      matches: (groups) => groups.bluray || groups.bdrip || groups.brrip
    },
    {
      source: Source.WEBRIP,
      matches: (groups) => groups.webrip
    },
    {
      source: Source.WEBDL,
      matches: (groups) => !groups.webrip && groups.webdl
    },
    {
      source: Source.DVD,
      matches: (groups) => groups.dvdr || groups.dvd && !groups.scr
    },
    {
      source: Source.PPV,
      matches: (groups) => groups.ppv
    },
    {
      source: Source.WORKPRINT,
      matches: (groups) => groups.workprint
    },
    {
      source: Source.TV,
      matches: (groups) => groups.pdtv || groups.sdtv || groups.dsr || groups.tvrip || groups.hdtv
    },
    {
      source: Source.CAM,
      matches: (groups) => groups.cam
    },
    {
      source: Source.TELESYNC,
      matches: (groups) => groups.ts
    },
    {
      source: Source.TELECINE,
      matches: (groups) => groups.tc
    },
    {
      source: Source.SCREENER,
      matches: (groups) => groups.scr
    }
  ];
  function parseSourceGroups(title) {
    const normalizedName = title.replaceAll("_", " ").replaceAll("[", " ").replaceAll("]", " ").trim();
    const groups = {
      bluray: false,
      webdl: false,
      webrip: false,
      hdtv: false,
      bdrip: false,
      brrip: false,
      scr: false,
      dvdr: false,
      dvd: false,
      dsr: false,
      regional: false,
      ppv: false,
      ts: false,
      tc: false,
      cam: false,
      workprint: false,
      pdtv: false,
      sdtv: false,
      tvrip: false
    };
    for (const { group, regex } of sourceGroupPatterns) {
      groups[group] = regex.test(normalizedName);
    }
    return groups;
  }
  function parseSource(title, groups) {
    groups ??= parseSourceGroups(title);
    return sourcePolicies.filter(({ matches }) => matches(groups)).map(({ source }) => source);
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/resolution.js
  var Resolution;
  (function(Resolution) {
    Resolution["R2160P"] = "2160P";
    Resolution["R1080P"] = "1080P";
    Resolution["R720P"] = "720P";
    Resolution["R576P"] = "576P";
    Resolution["R540P"] = "540P";
    Resolution["R480P"] = "480P";
    Resolution["R360P"] = "360P";
  })(Resolution || (Resolution = {}));
  var resolutionPatterns = [
    {
      resolution: Resolution.R2160P,
      regex: /2160p|3840x2160|4096x2160|4k[-_. ](?:UHD|HEVC|BD|H\.?265)|(?:UHD|HEVC|BD|H\.?265)[-_. ]4k|\b(4k)\b|COMPLETE.UHD|UHD.COMPLETE/i
    },
    {
      resolution: Resolution.R1080P,
      regex: /(1080(i|p)|1920x1080|1440p|\bFHD\b|4kto1080p)(10bit)?/i
    },
    { resolution: Resolution.R720P, regex: /(720(i|p)|1280x720|960p)(10bit)?/i },
    { resolution: Resolution.R576P, regex: /576(i|p)/i },
    { resolution: Resolution.R540P, regex: /540(i|p)/i },
    { resolution: Resolution.R480P, regex: /480(i|p)|640x480|848x480/i },
    { resolution: Resolution.R360P, regex: /360p/i }
  ];
  function parseResolution(title, precomputedSource) {
    const parsedResolution = parseResolutionFromTitle(title);
    if (parsedResolution.resolution) {
      return parsedResolution;
    }
    const source = precomputedSource ?? parseSource(title);
    if (source.includes(Source.DVD)) {
      return { resolution: Resolution.R480P };
    }
    return {};
  }
  function parseResolutionFromTitle(title) {
    for (const { resolution, regex } of resolutionPatterns) {
      const match = regex.exec(title);
      if (match) {
        return {
          resolution,
          source: match[0]
        };
      }
    }
    return {};
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/title/boundaries.js
  var titleBoundaryParsers = [
    { name: "resolution", parse: (title) => parseResolution(title).source },
    { name: "audio-codec", parse: (title) => parseAudioCodec(title).source },
    { name: "audio-channels", parse: (title) => parseAudioChannels(title).source },
    { name: "video-codec", parse: (title) => parseVideoCodec(title).source }
  ];
  function getFirstTitleBoundaryPosition(title) {
    const positions = titleBoundaryParsers.map(({ parse }) => parse(title)).map((source) => source ? title.indexOf(source) : -1).filter((position) => position > 0);
    return positions.length > 0 ? Math.min(...positions) : null;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/language.js
  var Language;
  (function(Language) {
    Language["English"] = "English";
    Language["French"] = "French";
    Language["Spanish"] = "Spanish";
    Language["German"] = "German";
    Language["Italian"] = "Italian";
    Language["Danish"] = "Danish";
    Language["Dutch"] = "Dutch";
    Language["Japanese"] = "Japanese";
    Language["Cantonese"] = "Cantonese";
    Language["Mandarin"] = "Mandarin";
    Language["Russian"] = "Russian";
    Language["Polish"] = "Polish";
    Language["Vietnamese"] = "Vietnamese";
    Language["Nordic"] = "Nordic";
    Language["Swedish"] = "Swedish";
    Language["Norwegian"] = "Norwegian";
    Language["Finnish"] = "Finnish";
    Language["Turkish"] = "Turkish";
    Language["Portuguese"] = "Portuguese";
    Language["Flemish"] = "Flemish";
    Language["Greek"] = "Greek";
    Language["Korean"] = "Korean";
    Language["Hungarian"] = "Hungarian";
    Language["Persian"] = "Persian";
    Language["Bengali"] = "Bengali";
    Language["Bulgarian"] = "Bulgarian";
    Language["Brazilian"] = "Brazilian";
    Language["Hebrew"] = "Hebrew";
    Language["Czech"] = "Czech";
    Language["Ukrainian"] = "Ukrainian";
    Language["Catalan"] = "Catalan";
    Language["Chinese"] = "Chinese";
    Language["Thai"] = "Thai";
    Language["Hindi"] = "Hindi";
    Language["Tamil"] = "Tamil";
    Language["Telugu"] = "Telugu";
    Language["Malayalam"] = "Malayalam";
    Language["Kannada"] = "Kannada";
    Language["Arabic"] = "Arabic";
    Language["Estonian"] = "Estonian";
    Language["Icelandic"] = "Icelandic";
    Language["Latvian"] = "Latvian";
    Language["Lithuanian"] = "Lithuanian";
    Language["Romanian"] = "Romanian";
    Language["Slovak"] = "Slovak";
    Language["Serbian"] = "Serbian";
  })(Language || (Language = {}));
  var languageAliasRules = [
    { language: Language.English, aliases: ["english", "eng", "en"] },
    { language: Language.Spanish, aliases: ["spanish", "spa", "esp", "castellano"] },
    { language: Language.Danish, aliases: ["dk", "dan", "danish"] },
    { language: Language.Japanese, aliases: ["japanese", "jap", "jpn"] },
    { language: Language.Cantonese, aliases: ["cantonese"] },
    { language: Language.Mandarin, aliases: ["mandarin"] },
    { language: Language.Korean, aliases: ["korean", "kor"] },
    { language: Language.Vietnamese, aliases: ["vietnamese", "vie"] },
    { language: Language.Swedish, aliases: ["se", "swe", "swedish"] },
    { language: Language.Finnish, aliases: ["fi", "finnish"] },
    { language: Language.Turkish, aliases: ["turkish"] },
    { language: Language.Portuguese, aliases: ["portuguese"] },
    { language: Language.Hebrew, aliases: ["hebrew", "hebdub"] },
    { language: Language.Czech, aliases: ["cz", "czech"] },
    { language: Language.Ukrainian, aliases: ["ukr", "ukrainian"] },
    { language: Language.Catalan, aliases: ["catalan"] },
    { language: Language.Estonian, aliases: ["estonian"] },
    { language: Language.Icelandic, aliases: ["ice", "icelandic"] },
    { language: Language.Chinese, aliases: ["chi", "chinese"] },
    { language: Language.Thai, aliases: ["thai"] },
    { language: Language.Italian, aliases: ["ita", "italian"] },
    { language: Language.German, aliases: ["german", "ger", "deu", "deutsch", "videomann"] },
    { language: Language.Flemish, aliases: ["flemish"] },
    { language: Language.Greek, aliases: ["greek"] },
    {
      language: Language.French,
      aliases: [
        "fr",
        "fre",
        "fra",
        "french",
        "vostfr",
        "vo",
        "vff",
        "vfq",
        "vf2",
        "truefrench",
        "subfrench"
      ]
    },
    { language: Language.Russian, aliases: ["rus", "russian"] },
    { language: Language.Norwegian, aliases: ["no", "norwegian"] },
    { language: Language.Hungarian, aliases: ["hun", "hundub", "hungarian"] },
    { language: Language.Polish, aliases: ["pl", "pldub", "polish"] },
    { language: Language.Dutch, aliases: ["nl", "dutch"] },
    { language: Language.Hindi, aliases: ["hin", "hindi"] },
    { language: Language.Tamil, aliases: ["tam", "tamil"] },
    { language: Language.Telugu, aliases: ["tel", "telugu"] },
    { language: Language.Malayalam, aliases: ["malayalam"] },
    { language: Language.Kannada, aliases: ["kannada"] },
    { language: Language.Arabic, aliases: ["arabic"] },
    { language: Language.Latvian, aliases: ["latvian"] },
    { language: Language.Lithuanian, aliases: ["lithuanian"] },
    { language: Language.Romanian, aliases: ["ro", "romanian", "rodubbed"] },
    { language: Language.Slovak, aliases: ["sk", "slovak"] },
    { language: Language.Brazilian, aliases: ["brazilian", "dublado"] },
    { language: Language.Persian, aliases: ["persian"] },
    { language: Language.Bengali, aliases: ["bengali"] },
    { language: Language.Bulgarian, aliases: ["bulgarian"] },
    { language: Language.Serbian, aliases: ["serbian"] },
    { language: Language.Nordic, aliases: ["nordic", "nordicsubs"] }
  ];
  var tokenExp = /[a-z0-9]+/gi;
  var multiTokens = new Set(["multi", "dual", "dl"]);
  var languageAliasTokens = new Set(languageAliasRules.flatMap(({ aliases }) => aliases));
  var languageOrMultiExp = new RegExp(`\\b(?:${[...languageAliasTokens, ...multiTokens].join("|")})\\b`, "i");
  function parseLanguageInfo(title, parsedTitle) {
    if (!languageOrMultiExp.test(title)) {
      return { languages: [Language.English] };
    }
    const allTitleTokens = tokenize(title);
    const multi = hasMultiLanguageToken(allTitleTokens) || undefined;
    if (!hasLanguageAliasToken(allTitleTokens) && !multi) {
      return { languages: [Language.English], multi };
    }
    parsedTitle ??= parseTitleAndYear(title).title;
    const titleTokens = removeParsedTitleTokens(allTitleTokens, tokenize(parsedTitle));
    const titleTokenSet = new Set(titleTokens);
    const languages = languageAliasRules.filter(({ aliases }) => aliases.some((alias) => titleTokenSet.has(alias))).map(({ language }) => language);
    if (hasMultiLanguageToken(titleTokens)) {
      languages.push(Language.English);
    }
    if (languages.length === 0) {
      languages.push(Language.English);
    }
    return { languages: [...new Set(languages)], multi };
  }
  function tokenize(title) {
    return Array.from(title.matchAll(tokenExp), (match) => match[0].toLowerCase());
  }
  function removeParsedTitleTokens(titleTokens, parsedTitleTokens) {
    if (parsedTitleTokens.length === 0 || parsedTitleTokens.length > titleTokens.length) {
      return titleTokens;
    }
    const startIndex = findTokenSequence(titleTokens, parsedTitleTokens);
    if (startIndex === -1) {
      return titleTokens;
    }
    return [
      ...titleTokens.slice(0, startIndex),
      ...titleTokens.slice(startIndex + parsedTitleTokens.length)
    ];
  }
  function findTokenSequence(tokens, sequence) {
    return tokens.findIndex((_, index) => sequence.every((sequenceToken, sequenceIndex) => tokens[index + sequenceIndex] === sequenceToken));
  }
  function hasMultiLanguageToken(tokens) {
    return tokens.some((token, index) => multiTokens.has(token) && !(token === "dl" && tokens[index - 1] === "web"));
  }
  function hasLanguageAliasToken(tokens) {
    return tokens.some((token) => languageAliasTokens.has(token));
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/title/cleanup.js
  var resolutionOrCodecDetailsExp = /\s*(?:480[ip]|576[ip]|720[ip]|1080[ip]|2160[ip]|HVEC|[xh][\W_]?26[45]|DD\W?5\W1|[<>?*:|]|848x480|1280x720|1920x1080)((8|10)b(it))?/i;
  var cleanTorrentPrefixRegex = /^\[(?:REQ)\]/i;
  var commonSourceMarkerExp = /\b(Bluray|(dvdr?|BD)rip|HDTV|HDRip|TS|R5|CAM|SCR|(WEB|DVD)?.?SCREENER|DiVX|xvid|web-?dl)\b/i;
  var commonSourceMarkersGlobalExp = new RegExp(commonSourceMarkerExp.source, "ig");
  var codecGlobalExp = new RegExp(codecExp.source, "ig");
  function applyCleanupPass(title, pass) {
    const cleanedTitle = "pattern" in pass ? title.replace(pass.pattern, pass.replacement ?? "") : pass.clean(title);
    return pass.trimAfter === true ? cleanedTitle.trim() : cleanedTitle;
  }
  function applyCleanupPasses(title, passes) {
    let cleanedTitle = title;
    for (const pass of passes) {
      cleanedTitle = applyCleanupPass(cleanedTitle, pass);
    }
    return cleanedTitle;
  }
  var simplifyTitleCleanupPasses = [
    {
      name: "remove resolution and first codec details",
      pattern: resolutionOrCodecDetailsExp
    },
    {
      name: "remove website prefix",
      pattern: websitePrefixExp
    },
    {
      name: "remove website postfix",
      pattern: websitePostfixExp
    },
    {
      name: "remove torrent request prefix",
      pattern: cleanTorrentPrefixRegex
    },
    {
      name: "remove torrent tracker suffix",
      pattern: cleanTorrentSuffixExp
    },
    {
      name: "remove common source markers",
      pattern: commonSourceMarkersGlobalExp
    },
    {
      name: "remove web download marker",
      pattern: webdlExp
    },
    {
      name: "remove remaining codec markers",
      pattern: codecGlobalExp
    }
  ];
  function simplifyTitle(title) {
    return applyCleanupPasses(title, simplifyTitleCleanupPasses).trim();
  }
  var editionMarkerPattern = String.raw`(?:(?:(?:Extended|Ultimate)[-_. ']*)?(?:(?:Director|Collector)[-_. ']*s?[-_. ']*(?:Cut|Edition|Version)|Theatrical|Anniversary|The[-_. ']*Uncut|DC|Ultimate|Final(?=[-_. ']*(?:Cut|Edition|Version))|Extended|Special|Despecialized|unrated|\d{2,3}(?:th)?[-_. ']*Anniversary)(?:[-_. ']*(?:Cut|Edition|Version))?(?:[-_. ']*(?:Extended|Uncensored|Remastered|Unrated|Uncut|IMAX|Fan[-_. ']*Edit))?|(?:Uncensored|Remastered|Unrated|Uncut|IMAX|Fan[-_. ']*Edit|Edition|Restored|[234]in1)){1,3}`;
  var trailingLanguageMarkerPattern = String.raw`(?:${Object.values(Language).join("|")}|TRUE.?FRENCH|videomann|SUBFRENCH|PLDUB|MULTI)`;
  var editionSuffixExp = new RegExp(String.raw`(?:^|[-_. '([]+)${editionMarkerPattern}(?:[-_. ']+${trailingLanguageMarkerPattern})*[-_. ')\]]*$`, "i");
  var releaseBoundaryExp = new RegExp(String.raw`[-_. ']+(?:${commonSourceMarkerExp.source}|${webdlExp.source}|${codecExp.source})`, "i");
  var requestInfoSuffixExp = /(?:^|[-_. ']+)\[[^\]\r\n]+\][-_. ']*$/i;
  var languageMarkerSuffixExp = /\b(TRUE.?FRENCH|videomann|SUBFRENCH|PLDUB|MULTI)\b[-_. ']*$/i;
  var languageNameSuffixExp = new RegExp(String.raw`(?:^|[-_. ']+)(?:${Object.values(Language).map((l) => l.toUpperCase()).join("|")})[-_. ']*$`);
  var sceneGarbageSuffixExp = /(?:^|[-_. ']+)(?:PROPER|REAL|READ.NFO)(?:[-_. ']+(?:PROPER|REAL|READ.NFO))*[-_. ']*$/i;
  var titleContentExp = /[a-z0-9]/i;
  var trailingMetadataSuffixExps = [
    requestInfoSuffixExp,
    languageMarkerSuffixExp,
    languageNameSuffixExp,
    sceneGarbageSuffixExp,
    editionSuffixExp
  ];
  function removeTitleSuffix(title, suffixExp) {
    suffixExp.lastIndex = 0;
    const cleanedTitle = title.replace(suffixExp, "");
    return titleContentExp.test(cleanedTitle) ? cleanedTitle : title;
  }
  function trimTrailingReleaseMetadata(title) {
    let trimmedTitle = title.trim();
    let removedSuffix = true;
    while (removedSuffix) {
      removedSuffix = false;
      for (const suffixExp of trailingMetadataSuffixExps) {
        const cleanedTitle = removeTitleSuffix(trimmedTitle, suffixExp).trim();
        if (cleanedTitle !== trimmedTitle) {
          trimmedTitle = cleanedTitle;
          removedSuffix = true;
          break;
        }
      }
    }
    return trimmedTitle;
  }
  function truncateAtReleaseMetadataBoundary(title) {
    releaseBoundaryExp.lastIndex = 0;
    const match = releaseBoundaryExp.exec(title);
    return match && match.index > 0 ? title.slice(0, match.index) : title;
  }
  var releaseTitleCleanupPasses = [
    {
      name: "replace first underscore",
      clean: (title) => title.replace("_", " ")
    },
    {
      name: "truncate at release metadata boundary",
      clean: truncateAtReleaseMetadataBoundary,
      trimAfter: true
    },
    {
      name: "trim trailing release metadata",
      clean: trimTrailingReleaseMetadata,
      trimAfter: true
    },
    {
      name: "truncate at double space gap",
      clean: (title) => title.split("  ")[0]
    },
    {
      name: "truncate at double dot gap",
      clean: (title) => title.split("..")[0]
    }
  ];
  function isCleanableReleaseTitle(title) {
    return title.length > 0 && title !== "(";
  }
  function shouldPreservePeriod(segment, previousSegmentWasAcronym, nextSegment) {
    if (segment.length !== 1) {
      return false;
    }
    if (segment.toLowerCase() !== "a") {
      return Number.isNaN(Number.parseInt(segment, 10));
    }
    return previousSegmentWasAcronym || nextSegment.length === 1;
  }
  function formatDottedTitleSegments(title) {
    const segments = title.split(".");
    let formattedTitle = "";
    let previousSegmentWasAcronym = false;
    let nextSegment = "";
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segments.length >= segmentIndex + 2) {
        nextSegment = segments[segmentIndex + 1] ?? "";
      }
      if (shouldPreservePeriod(segment, previousSegmentWasAcronym, nextSegment)) {
        formattedTitle += `${segment}.`;
        previousSegmentWasAcronym = true;
        continue;
      }
      if (previousSegmentWasAcronym) {
        formattedTitle += " ";
        previousSegmentWasAcronym = false;
      }
      formattedTitle += `${segment} `;
    }
    return formattedTitle.trim();
  }
  function releaseTitleCleaner(title) {
    if (!isCleanableReleaseTitle(title)) {
      return null;
    }
    const trimmedTitle = applyCleanupPasses(title, releaseTitleCleanupPasses);
    return formatDottedTitleSegments(trimmedTitle);
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/title/patterns.js
  var releaseGroupSuffixExp = /-([a-z0-9]+)$/i;
  var movieTitleYearPatterns = [
    {
      name: "edition-before-year",
      regex: /^(?<title>(?![([])[^\r\n]+?)?(?:(?:[-_\W](?<![)[!]))*\(?\b(?<edition>(((?:Extended[-_. ']|Ultimate[-_. '])?(?:Director[-_. ']?s|Collector[-_. ']?s|Theatrical|Anniversary|The[-_. ']Uncut|Ultimate|Final(?=(?:[-_. '](?:Cut|Edition|Version)))|Extended|Rogue|Special|Despecialized|\d{2,3}(?:th)?[-_. ']Anniversary)(?:[-_. '](?:Cut|Edition|Version))?(?:[-_. '](?:Extended|Uncensored|Remastered|Unrated|Uncut|IMAX|Fan[-_. ']?Edit))?|(?:Uncensored|Remastered|Unrated|Uncut|IMAX|Fan[-_. ']?Edit|Edition|Restored|[234]in1))))\b\)?[-_. ]{1,3}(?<year>(?:1[89]|20)\d{2}(?!p|i|\d+|\]|\W\d+)))+(\W+|_|$)(?!\\)/i
    },
    {
      name: "parenthesized-year",
      regex: /^(?<title>(?![([])[^\r\n]+?)?(?:(?:[-_\W](?<![)[!]))*\((?<year>(?:1[89]|20)\d{2}(?!p|i|(?:1[89]|20)\d{2}|\]|\W(?:1[89]|20)\d{2})))+/i
    },
    {
      name: "normal-year",
      regex: /^(?<title>(?![([])[^\r\n]+?)?(?:(?:[-_\W](?<![)[!]))*(?<year>(?:1[89]|20)\d{2}(?!p|i|(?:1[89]|20)\d{2}|\]|\W(?:1[89]|20)\d{2})))+(\W+|_|$)(?!\\)/i
    },
    {
      name: "pass-the-popcorn-tag",
      regex: /^(?<title>[^\r\n]+?)?(?:(?:[-_\W](?<![()[!]))*(?<year>\[[\w ]{1,64}\]))+(\W+|_|$)(?!\\)/i
    },
    {
      name: "loose-year",
      regex: /^(?<title>(?![([])[^\r\n]+?)?(?:(?:[-_\W](?<![)!]))*(?<year>(?:1[89]|20)\d{2}(?!p|i|\d+|\W\d+)))+(\W+|_|$)(?!\\)/i
    },
    {
      name: "bracketed-title-loose-year",
      regex: /^(?<title>[^\r\n]+?)?(?:(?:[-_\W](?<![)[!]))*(?<year>(?:1[89]|20)\d{2}(?!p|i|\d+|\]|\W\d+)))+(\W+|_|$)(?!\\)/i
    }
  ];

  // node_modules/@ctrl/video-filename-parser/dist/src/title/index.js
  var commonReleaseTitleYearExp = /^(?<title>(?![([])[^\r\n]+?)[-_. ](?<year>(?:1[89]|20)\d{2})(?=[-_. ](?:2160p|1080p|720p|576p|540p|480p|UHD|Blu-?Ray|Bluray|WEB[-_. ]?DL|WEBRip|HDRip|HDTV|DVDRip|BDRip|BRRip)\b)/i;
  function parseTitleAndYear(title) {
    const commonRelease = parseCommonReleaseTitleYear(title);
    if (commonRelease !== null) {
      return commonRelease;
    }
    const simpleTitle = simplifyTitle(title);
    const grouplessTitle = simpleTitle.replace(releaseGroupSuffixExp, "");
    for (const pattern of movieTitleYearPatterns) {
      const result = parseTitleYearPattern(pattern, grouplessTitle);
      if (result !== null) {
        return result;
      }
    }
    const firstPosition = getFirstTitleBoundaryPosition(title);
    if (firstPosition !== null) {
      return { title: releaseTitleCleaner(title.slice(0, firstPosition)) ?? "", year: null };
    }
    return { title: title.trim(), year: null };
  }
  function parseCommonReleaseTitleYear(title) {
    if (hasWebsitePrefix(title)) {
      return null;
    }
    const match = commonReleaseTitleYearExp.exec(title);
    if (!match?.groups) {
      return null;
    }
    const cleanTitle = releaseTitleCleaner(match.groups.title ?? "");
    if (cleanTitle === null) {
      return null;
    }
    return {
      title: cleanTitle,
      year: match.groups.year ?? null
    };
  }
  function parseTitleYearPattern(pattern, title) {
    const match = pattern.regex.exec(title);
    if (!match?.groups) {
      return null;
    }
    const cleanTitle = releaseTitleCleaner(match.groups.title ?? "");
    if (cleanTitle === null) {
      return null;
    }
    return {
      title: cleanTitle,
      year: match.groups.year ?? null
    };
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/edition.js
  var hasSbsMarker = (title) => title.includes("sbs");
  var hasHardcodedSubsMarker = (title) => title.includes("sub") || title.includes("hc");
  var editionPatterns = [
    { flag: "internal", regex: /\b(INTERNAL)\b/i },
    { flag: "limited", regex: /\b(LIMITED)\b/i },
    { flag: "remastered", regex: /\b(Remastered|Anniversary|Restored)\b/i },
    { flag: "extended", regex: /\b(Extended|Uncut|Ultimate|Rogue|Collector)\b/i },
    { flag: "theatrical", regex: /\b(Theatrical)\b/i },
    { flag: "directors", regex: /\b(Directors?)\b/i },
    { flag: "unrated", regex: /\b(Uncensored|Unrated)\b/i },
    { flag: "imax", regex: /\b(IMAX)\b/i },
    { flag: "fanEdit", regex: /\b(Despecialized|Fan.?Edit)\b/i },
    { flag: "hdr", regex: /\b(HDR(?:10(?:\+|Plus)?)?)\b/i, includeTitle: true },
    { flag: "bw", regex: /\b(BW)\b/i, includeTitle: true },
    { flag: "threeD", regex: /\b(3D)\b/i, includeTitle: true },
    { flag: "hsbs", regex: /\b(Half-?SBS|HSBS)\b/i, hint: hasSbsMarker, includeTitle: true },
    { flag: "sbs", regex: /\b((?<!H|HALF-)SBS)\b/i, hint: hasSbsMarker, includeTitle: true },
    { flag: "hou", regex: /\b(HOU)\b/i, includeTitle: true },
    { flag: "uhd", regex: /\b(UHD)\b/i, includeTitle: true },
    { flag: "oar", regex: /\b(OAR)\b/i, includeTitle: true },
    { flag: "dolbyVision", regex: /\b(DV|DoVi|Dolby[-_. ]?Vision)\b/i, includeTitle: true },
    {
      flag: "hardcodedSubs",
      regex: /\b((?<hcsub>(\w+(?<!SOFT|MULTI|HORRIBLE)SUBS?))|(?<hc>(HC|SUBBED)))\b/i,
      hint: hasHardcodedSubsMarker
    },
    { flag: "deletedScenes", regex: /\b((Bonus.)?Deleted.Scenes)\b/i },
    {
      flag: "bonusContent",
      regex: /\b((Bonus|Extras|Behind.the.Scenes|Making.of|Interviews|Featurettes|Outtakes|Bloopers|Gag.Reel).(?!(Deleted.Scenes)))\b/i
    }
  ];
  function parseEdition(title, parsedTitle) {
    parsedTitle ??= parseTitleAndYear(title).title;
    const fullTitle = normalizeSeparators(title).toLowerCase();
    const withoutTitle = getEditionSearchText(title, parsedTitle);
    const result = {};
    for (const { flag, regex, hint, includeTitle } of editionPatterns) {
      const searchText = includeTitle ? fullTitle : withoutTitle;
      if ((hint === undefined || hint(searchText)) && regex.test(searchText)) {
        result[flag] = true;
      }
    }
    return result;
  }
  var titleSeparatorExp = /[._]/g;
  function getEditionSearchText(title, parsedTitle) {
    return normalizeSeparators(title).replace(normalizeSeparators(parsedTitle), "").toLowerCase();
  }
  function normalizeSeparators(title) {
    return title.replaceAll(titleSeparatorExp, " ");
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/complete.js
  var completeDvdExp = /\b(NTSC|PAL)?.DVDR\b/i;
  function isCompleteDvd(title) {
    return completeDvdExp.test(title) || undefined;
  }
  var completeExp = /\b(COMPLETE)\b/i;
  function isComplete(title) {
    return completeExp.test(title) || isCompleteDvd(title) || undefined;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/extensions.js
  var fileExtensions = [
    ".webm",
    ".m4v",
    ".3gp",
    ".nsv",
    ".ty",
    ".strm",
    ".rm",
    ".rmvb",
    ".m3u",
    ".ifo",
    ".mov",
    ".qt",
    ".divx",
    ".xvid",
    ".bivx",
    ".nrg",
    ".pva",
    ".wmv",
    ".asf",
    ".asx",
    ".ogm",
    ".ogv",
    ".m2v",
    ".avi",
    ".bin",
    ".dat",
    ".dvr-ms",
    ".mpg",
    ".mpeg",
    ".mp4",
    ".avc",
    ".vp3",
    ".svq3",
    ".nuv",
    ".viv",
    ".dv",
    ".fli",
    ".flv",
    ".wpl",
    ".img",
    ".iso",
    ".vob",
    ".mkv",
    ".mk3d",
    ".ts",
    ".wtv",
    ".m2ts"
  ];
  var supportedFileExtensions = new Set(fileExtensions);
  var minExtensionLength = 3;
  var maxExtensionLength = 7;
  var code = {
    dot: 46,
    a: 97,
    b: 98,
    e: 101,
    f: 102,
    g: 103,
    i: 105,
    k: 107,
    l: 108,
    m: 109,
    o: 111,
    p: 112,
    s: 115,
    t: 116,
    v: 118,
    w: 119,
    four: 52,
    two: 50
  };
  function removeFileExtension(title) {
    const extensionStart = findCandidateExtensionStart(title);
    if (extensionStart === -1) {
      return title;
    }
    if (hasCommonFileExtension(title, extensionStart)) {
      return title.slice(0, extensionStart);
    }
    const extension = title.slice(extensionStart).toLowerCase();
    if (supportedFileExtensions.has(extension) || fileExtensions.includes(extension)) {
      return title.slice(0, extensionStart);
    }
    return title;
  }
  function hasCommonFileExtension(title, extensionStart) {
    const extensionLength = title.length - extensionStart;
    switch (extensionLength) {
      case 3: {
        return hasCommonTwoCharacterExtension(title, extensionStart);
      }
      case 4: {
        return hasCommonThreeCharacterExtension(title, extensionStart);
      }
      case 5: {
        return hasCommonFourCharacterExtension(title, extensionStart);
      }
      default: {
        return false;
      }
    }
  }
  function findCandidateExtensionStart(title) {
    const minStart = Math.max(0, title.length - maxExtensionLength);
    for (let i = title.length - minExtensionLength;i >= minStart; i--) {
      if (title.charCodeAt(i) === code.dot) {
        return i;
      }
    }
    return -1;
  }
  function hasCommonTwoCharacterExtension(title, start) {
    return lowerAsciiCodeAt(title, start + 1) === code.t && lowerAsciiCodeAt(title, start + 2) === code.s;
  }
  function hasCommonThreeCharacterExtension(title, start) {
    const first = lowerAsciiCodeAt(title, start + 1);
    const second = lowerAsciiCodeAt(title, start + 2);
    const third = lowerAsciiCodeAt(title, start + 3);
    switch (first) {
      case code.a: {
        return second === code.v && third === code.i;
      }
      case code.f: {
        return second === code.l && third === code.v;
      }
      case code.m: {
        return second === code.k && third === code.v || second === code.p && third === code.four || second === code.o && third === code.v || second === code.four && third === code.v || second === code.p && third === code.g;
      }
      case code.w: {
        return second === code.m && third === code.v;
      }
      default: {
        return false;
      }
    }
  }
  function hasCommonFourCharacterExtension(title, start) {
    const first = lowerAsciiCodeAt(title, start + 1);
    const second = lowerAsciiCodeAt(title, start + 2);
    const third = lowerAsciiCodeAt(title, start + 3);
    const fourth = lowerAsciiCodeAt(title, start + 4);
    switch (first) {
      case code.m: {
        return second === code.p && third === code.e && fourth === code.g || second === code.two && third === code.t && fourth === code.s;
      }
      case code.w: {
        return second === code.e && third === code.b && fourth === code.m;
      }
      default: {
        return false;
      }
    }
  }
  function lowerAsciiCodeAt(value, index) {
    const charCode = value.charCodeAt(index);
    return charCode >= 65 && charCode <= 90 ? charCode + 32 : charCode;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/group.js
  var cleanReleaseGroupExp = /(-(RP|1|NZBGeek|Obfuscated|Obfuscation|Scrambled|sample|Pre|postbot|xpost|Rakuv[a-z0-9]*|WhiteRev|BUYMORE|AsRequested|AlternativeToRequested|GEROV|Z0iDS3N|Chamele0n|4P|4Planet|AlteZachen|RePACKPOST))+$/i;
  var releaseGroupRegexExp = /-(?<releasegroup>[a-z0-9]+)(?<!WEB-DL|WEB-RIP|480p|720p|1080p|2160p|DTS-(HD|X|MA|ES)|([a-zA-Z]{3}-ENG))(?:\b|[-._ ])/i;
  var animeReleaseGroupExp = /^\[(?<subgroup>[^\s\]\r\n](?:[^\]\r\n]{0,318}[^\s\]\r\n])?)\](?:_|-|\s|\.)?/i;
  var exceptionReleaseGroupRegex = /(\[)?(?<releasegroup>(Joy|YIFY|YTS.(MX|LT|AG)|AnimePahe|FreetheFish|VH-PROD|FTW-HS|DX-TV|Blu-bits|afm72|Anna|Bandi|Ghost|Kappa|MONOLITH|Qman|RZeroX|SAMPA|Silence|theincognito|D-Z0N3|t3nzin|Vyndros|HDO|DusIctv|DHD|SEV|CtrlHD|-ZR-|ADC|XZVN|RH|Kametsu|r00t|HONE))(\])?$/i;
  var globalReleaseGroupExp = new RegExp(releaseGroupRegexExp.source, "ig");
  var simpleReleaseGroupSuffixExp = /-(?<releasegroup>[a-z0-9]+)$/i;
  var protectedReleaseGroups = new Set(["web-dl", "web-rip", "480p", "720p", "1080p", "2160p"]);
  var simpleExceptionReleaseGroups = new Set([
    "joy",
    "yify",
    "animepahe",
    "freethefish",
    "afm72",
    "anna",
    "bandi",
    "ghost",
    "kappa",
    "monolith",
    "qman",
    "rzerox",
    "sampa",
    "silence",
    "theincognito",
    "t3nzin",
    "vyndros",
    "hdo",
    "dusictv",
    "dhd",
    "sev",
    "ctrlhd",
    "adc",
    "xzvn",
    "rh",
    "kametsu",
    "r00t",
    "hone"
  ]);
  var dZ0n3ReleaseGroupSuffix = "d-z0n3";
  function parseGroup(title, parsedTitle) {
    const simpleGroup = matchSimpleReleaseGroup(title);
    if (simpleGroup !== null) {
      return simpleGroup;
    }
    const nowebsiteTitle = removeWebsitePrefix(title);
    const releaseTitle = normalizeReleaseTitle(nowebsiteTitle, parsedTitle);
    let trimmed = buildGroupCandidateTitle(nowebsiteTitle, releaseTitle);
    if (trimmed.length === 0) {
      return null;
    }
    const exceptionGroup = matchExceptionReleaseGroup(trimmed);
    if (exceptionGroup !== null) {
      return exceptionGroup;
    }
    const animeSubgroup = matchAnimeSubgroup(trimmed);
    if (animeSubgroup !== null) {
      return animeSubgroup;
    }
    trimmed = simplifyTitle(trimmed);
    trimmed = stripCleanupSuffixes(trimmed);
    return matchGenericReleaseGroup(trimmed);
  }
  function matchSimpleReleaseGroup(title) {
    const titleWithoutExtension = removeFileExtension(title.trim());
    const separatorIndex = titleWithoutExtension.lastIndexOf("-");
    if (separatorIndex === -1 || titleWithoutExtension.lastIndexOf("-", separatorIndex - 1) !== -1) {
      return null;
    }
    const match = simpleReleaseGroupSuffixExp.exec(titleWithoutExtension);
    const group = match?.groups?.releasegroup;
    if (!group) {
      return null;
    }
    const normalizedGroup = group.toLowerCase();
    if (protectedReleaseGroups.has(normalizedGroup) || simpleExceptionReleaseGroups.has(normalizedGroup) || titleWithoutExtension.toLowerCase().endsWith(dZ0n3ReleaseGroupSuffix)) {
      return null;
    }
    return group;
  }
  function normalizeReleaseTitle(title, parsedTitle) {
    return (parsedTitle ?? parseTitleAndYear(title).title).replaceAll(" ", ".");
  }
  function buildGroupCandidateTitle(title, releaseTitle) {
    const trimmed = title.replaceAll(" ", ".").replace(releaseTitle === title ? "" : releaseTitle, "").replaceAll(".-.", ".").replace(cleanTorrentSuffixExp, "");
    return removeFileExtension(trimmed.trim());
  }
  function matchExceptionReleaseGroup(title) {
    const exceptionResult = exceptionReleaseGroupRegex.exec(title);
    if (exceptionResult?.groups?.releasegroup) {
      return exceptionResult.groups.releasegroup;
    }
    return null;
  }
  function matchAnimeSubgroup(title) {
    const animeResult = animeReleaseGroupExp.exec(title);
    return animeResult?.groups?.subgroup ?? null;
  }
  function stripCleanupSuffixes(title) {
    return title.replace(cleanReleaseGroupExp, "");
  }
  function matchGenericReleaseGroup(title) {
    globalReleaseGroupExp.lastIndex = 0;
    for (const result of title.matchAll(globalReleaseGroupExp)) {
      if (!result?.groups) {
        continue;
      }
      const group = result.groups.releasegroup ?? "";
      return group;
    }
    return null;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/quality.js
  var properRegex = /\b(?<proper>proper)\b/i;
  var realRegex = /\b(?<real>REAL)\b/;
  var realGlobalExp = new RegExp(realRegex.source, "g");
  var repackRegex = /\b(?<repack>repack\d?|rerip\d?)\b/i;
  var versionExp = /\d[-._ ]?v(\d)[-._ ]|\bv(\d)\b(?!.*\b(?:19|20)\d{2}\b)|\[v(\d)\]|repack(\d)|rerip(\d)/i;
  var remuxExp = /\b(?<remux>(BD|UHD)?Remux)\b/i;
  var bdiskExp = /\b(COMPLETE|ISO|BDISO|BDMux|BDMV|BD25|BD50|BD66|BD100|BD[-_. ]?(?:25|50|66|100)|BR[-_. ]?DISK|Full[-_. ]?Blu[-_. ]?ray|3D[-_. ]?BD)\b/i;
  var discCodecExp = /\b(AVC|HEVC|VC[-_. ]?1|MVC|MPEG[-_. ]?2)\b/i;
  var brDiskExclusionExp = /\b((?<!HD[._ -]|HD)DVD|BDRip|720p|MKV|XviD|WMV|d3g|(BD)?REMUX|[xh][-_. ]?26[45])\b/i;
  var hardBrDiskExclusionExp = /\b((?<!HD[._ -]|HD)DVD|BDRip|720p|MKV|XviD|WMV|d3g|(BD)?REMUX)\b/i;
  var brDiskSourceExp = /(?:blu[-_. ]?ray|hd[-_. ]?dvd)/i;
  var rawHdExp = /\b(?<rawhd>RawHD|1080i[-_. ]HDTV|Raw[-_. ]HD|MPEG[-_. ]?2)\b/i;
  var extensionExp = /\.[a-z0-9-]+$/i;
  var sdtvExtensionSet = new Set([
    ".m4v",
    ".3gp",
    ".nsv",
    ".ty",
    ".strm",
    ".rm",
    ".rmvb",
    ".m3u",
    ".ifo",
    ".mov",
    ".qt",
    ".divx",
    ".xvid",
    ".bivx",
    ".nrg",
    ".pva",
    ".wmv",
    ".asf",
    ".asx",
    ".ogm",
    ".ogv",
    ".m2v",
    ".avi",
    ".bin",
    ".dat",
    ".dvr-ms",
    ".mpg",
    ".mpeg",
    ".mp4",
    ".avc",
    ".vp3",
    ".svq3",
    ".nuv",
    ".viv",
    ".dv",
    ".fli",
    ".flv",
    ".wpl",
    ".ts",
    ".wtv"
  ]);
  var highDefPdtvRegex = /hr[-_. ]ws/i;
  var sceneCodecMarker = String.raw`(?:[xh][-. ]?26[45]|h[-. ]?26[45])`;
  var commonSceneBlurayExp = new RegExp(String.raw`\b(?:1080p|2160p)(?:[-_. ]uhd)?[-_. ]bluray[-_. ]${sceneCodecMarker}\b`, "i");
  var commonSceneWebExp = new RegExp(String.raw`\b(?:1080p|2160p)[-_. ]web[-_. ]${sceneCodecMarker}\b`, "i");
  var uncommonXvidExp = /x-?vid|divx/i;
  var QualityModifier;
  (function(QualityModifier) {
    QualityModifier["REMUX"] = "REMUX";
    QualityModifier["BRDISK"] = "BRDISK";
    QualityModifier["RAWHD"] = "RAWHD";
  })(QualityModifier || (QualityModifier = {}));
  function parseQualityModifyers(title) {
    const normalizedTitle = title.trim().replaceAll("_", " ").trim().toLowerCase();
    const result = {
      version: 1,
      real: 0
    };
    if (properRegex.test(normalizedTitle)) {
      result.version = 2;
    }
    const versionResult = versionExp.exec(normalizedTitle);
    const versionText = versionResult?.slice(1).find(Boolean);
    const version = versionText === undefined ? undefined : Number.parseInt(versionText, 10);
    if (versionResult && version !== undefined && !Number.isNaN(version)) {
      result.version = version;
    }
    let realCount = 0;
    while (realGlobalExp.test(title)) {
      realCount += 1;
    }
    result.real = realCount;
    if (properRegex.test(normalizedTitle)) {
      result.version = version === undefined || Number.isNaN(version) ? 2 : version + 1;
    }
    if (repackRegex.test(normalizedTitle)) {
      result.version = version === undefined || Number.isNaN(version) ? 2 : version + 1;
      result.isRepack = true;
    }
    return result;
  }
  function parseQuality(title, codec) {
    const normalizedTitle = title.trim().replaceAll("_", " ").replaceAll("[", " ").replaceAll("]", " ").trim().toLowerCase();
    const revision = parseQualityModifyers(title);
    const { resolution } = parseResolutionFromTitle(normalizedTitle);
    const commonSceneQuality = parseCommonSceneQuality(normalizedTitle, revision, resolution, codec);
    if (commonSceneQuality !== null) {
      return commonSceneQuality;
    }
    codec ??= parseVideoCodec(title).codec;
    const sourceGroups = parseSourceGroups(normalizedTitle);
    const context = {
      title,
      normalizedTitle,
      sourceGroups,
      parsedResolution: resolution,
      codec,
      revision,
      modifier: parseQualityModifier(normalizedTitle, sourceGroups)
    };
    for (const policy of qualityPolicies) {
      if (policy.matches(context)) {
        return createQualityResult(context, policy.getOverrides(context));
      }
    }
    return createQualityResult(context);
  }
  function parseCommonSceneQuality(normalizedTitle, revision, resolution, codec) {
    if (!isModernSceneResolution(resolution) || codec === VideoCodec.XVID) {
      return null;
    }
    if (codec === undefined && uncommonXvidExp.test(normalizedTitle)) {
      return null;
    }
    if (commonSceneBlurayExp.test(normalizedTitle)) {
      return createCommonSceneQuality(Source.BLURAY, revision, resolution);
    }
    if (commonSceneWebExp.test(normalizedTitle)) {
      return createCommonSceneQuality(Source.WEBDL, revision, resolution);
    }
    return null;
  }
  function isModernSceneResolution(resolution) {
    return resolution === Resolution.R1080P || resolution === Resolution.R2160P;
  }
  function createCommonSceneQuality(source, revision, resolution) {
    return {
      sources: [source],
      resolution,
      revision,
      modifier: null
    };
  }
  function parseQualityModifier(normalizedTitle, sourceGroups) {
    if (isBrDisk(normalizedTitle, sourceGroups)) {
      return QualityModifier.BRDISK;
    }
    if (remuxExp.test(normalizedTitle) && !sourceGroups.webdl && !sourceGroups.hdtv) {
      return QualityModifier.REMUX;
    }
    if (rawHdExp.test(normalizedTitle)) {
      return QualityModifier.RAWHD;
    }
    return null;
  }
  function isBrDisk(normalizedTitle, sourceGroups) {
    if (!sourceGroups.bluray || hardBrDiskExclusionExp.test(normalizedTitle)) {
      return false;
    }
    if (bdiskExp.test(normalizedTitle)) {
      return true;
    }
    if (brDiskExclusionExp.test(normalizedTitle)) {
      return false;
    }
    return brDiskSourceExp.test(normalizedTitle) && discCodecExp.test(normalizedTitle);
  }
  function createQualityResult(context, overrides = {}) {
    return {
      sources: overrides.sources ?? getDefaultSources(context),
      resolution: overrides.resolution ?? context.parsedResolution ?? getDefaultResolution(context),
      revision: context.revision,
      modifier: overrides.modifier ?? context.modifier
    };
  }
  function getDefaultResolution(context) {
    const extensionQuality = getExtensionQuality(context);
    if (extensionQuality) {
      return extensionQuality.resolution;
    }
    return getParsedSources(context).includes(Source.DVD) ? Resolution.R480P : undefined;
  }
  function getDefaultSources(context) {
    if (context.modifier === QualityModifier.BRDISK || context.modifier === QualityModifier.REMUX) {
      return [Source.BLURAY];
    }
    if (context.modifier === QualityModifier.RAWHD) {
      return [Source.TV];
    }
    const parsedSources = getParsedSources(context);
    if (parsedSources.length > 0) {
      return parsedSources;
    }
    return getExtensionQuality(context)?.sources ?? [];
  }
  function getParsedSources(context) {
    context.parsedSources ??= parseSource(context.normalizedTitle, context.sourceGroups);
    return context.parsedSources;
  }
  function getExtensionQuality(context) {
    if (context.extensionQuality === undefined) {
      context.extensionQuality = getQualityFromExtension(context.title);
    }
    return context.extensionQuality;
  }
  function getQualityFromExtension(title) {
    const extension = extensionExp.exec(title)?.[0].toLowerCase();
    switch (extension) {
      case ".mkv":
      case ".mk3d": {
        return { sources: [Source.WEBDL], resolution: Resolution.R720P };
      }
      case ".m2ts": {
        return { sources: [Source.BLURAY], resolution: Resolution.R720P };
      }
      case ".img":
      case ".iso":
      case ".vob": {
        return { sources: [Source.DVD] };
      }
      case ".webm":
      case undefined: {
        return null;
      }
      default: {
        return sdtvExtensionSet.has(extension) ? { sources: [Source.TV], resolution: Resolution.R480P } : null;
      }
    }
  }
  var qualityPolicies = [
    {
      matches: ({ sourceGroups }) => sourceGroups.bluray,
      getOverrides: (context) => getXvidDvdOverrides(context) ?? {
        sources: [Source.BLURAY],
        resolution: getBlurayResolution(context)
      }
    },
    {
      matches: ({ sourceGroups }) => sourceGroups.webdl || sourceGroups.webrip,
      getOverrides: (context) => ({
        sources: getParsedSources(context),
        resolution: getWebResolution(context)
      })
    },
    {
      matches: ({ sourceGroups }) => sourceGroups.hdtv,
      getOverrides: (context) => ({
        sources: [Source.TV],
        resolution: getHdtvResolution(context)
      })
    },
    {
      matches: ({ sourceGroups }) => sourceGroups.pdtv || sourceGroups.sdtv || sourceGroups.dsr || sourceGroups.tvrip,
      getOverrides: (context) => ({
        sources: [Source.TV],
        resolution: highDefPdtvRegex.test(context.normalizedTitle) ? Resolution.R720P : Resolution.R480P
      })
    },
    {
      matches: ({ sourceGroups }) => sourceGroups.bdrip || sourceGroups.brrip,
      getOverrides: (context) => getXvidDvdOverrides(context) ?? {
        sources: [Source.BLURAY],
        resolution: context.parsedResolution ?? Resolution.R480P
      }
    },
    sourcePolicy(({ sourceGroups }) => sourceGroups.workprint, Source.WORKPRINT),
    sourcePolicy(({ sourceGroups }) => sourceGroups.cam, Source.CAM),
    sourcePolicy(({ sourceGroups }) => sourceGroups.ts, Source.TELESYNC),
    sourcePolicy(({ sourceGroups }) => sourceGroups.tc, Source.TELECINE),
    sourcePolicy((context) => !context.modifier && isHighDefinition(context.parsedResolution), Source.WEBDL)
  ];
  function sourcePolicy(matches, source) {
    return {
      matches,
      getOverrides: () => ({ sources: [source] })
    };
  }
  function getXvidDvdOverrides(context) {
    if (context.codec !== VideoCodec.XVID) {
      return null;
    }
    return {
      sources: [Source.DVD],
      resolution: Resolution.R480P
    };
  }
  function isHighDefinition(resolution) {
    return resolution === Resolution.R2160P || resolution === Resolution.R1080P || resolution === Resolution.R720P;
  }
  function getBlurayResolution(context) {
    if (context.modifier === QualityModifier.BRDISK) {
      return Resolution.R1080P;
    }
    if (context.parsedResolution) {
      return context.parsedResolution;
    }
    if (context.modifier === QualityModifier.REMUX) {
      return Resolution.R2160P;
    }
    return Resolution.R720P;
  }
  function getWebResolution(context) {
    if (context.parsedResolution) {
      return context.parsedResolution;
    }
    return context.title.includes("[WEBDL]") ? Resolution.R720P : Resolution.R480P;
  }
  function getHdtvResolution(context) {
    if (context.parsedResolution) {
      return context.parsedResolution;
    }
    return context.title.includes("[HDTV]") ? Resolution.R720P : Resolution.R480P;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/season/common.js
  var requestInfoExp = /^(?:\[[^\]\r\n]+\])+/;
  var sixDigitAirDateMatchExp = /(?<=[_.-])(?<airdate>(?<!\d)(?<airyear>[1-9]\d{1})(?<airmonth>[0-1][0-9])(?<airday>[0-3][0-9]))(?=[_.-])/i;
  var trailingRemainderRequestInfoExp = /(?:\s*\[[^\]\r\n]+\])+$/;
  var leadingRemainderSeparatorsExp = /^[-_.\s]+/;
  var leadingReleaseMetadataExp = /^(?:[ip][-_.\s]+[xh][-. ]?26[45]|(?:1[89]|20)\d{2}|480[ip]|576[ip]|720[ip]|1080[ip]|2160[ip]|WEB(?:[-_. ]?DL|Rip)?|Blu[-_. ]?Ray|HDTV|DVD(?:Rip)?|BDRip|BRRip|[xh][-. ]?26[45]|h[-. ]?26[45]|HEVC|XviD)\b/i;
  var remainderContentExp = /[a-z]/i;
  var episodeNumberWords = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine"
  ];
  function completeRange(arr) {
    const uniqArr = [...new Set(arr)];
    if (uniqArr.length === 0) {
      return [];
    }
    const first = Number(uniqArr[0]);
    const last = Number(uniqArr[uniqArr.length - 1]);
    const range = expandIntegerRange(first, last);
    if (range === null) {
      return arr;
    }
    return range;
  }
  function normalizeSixDigitAirDate(title, simpleTitle) {
    const sixDigitAirDateMatch = sixDigitAirDateMatchExp.exec(title);
    if (!sixDigitAirDateMatch?.groups) {
      return simpleTitle;
    }
    const airYear = sixDigitAirDateMatch.groups.airyear ?? "";
    const airMonth = sixDigitAirDateMatch.groups.airmonth ?? "";
    const airDay = sixDigitAirDateMatch.groups.airday ?? "";
    if (airMonth === "00" && airDay === "00") {
      return simpleTitle;
    }
    const fixedDate = `20${airYear}.${airMonth}.${airDay}`;
    return simpleTitle.replace(sixDigitAirDateMatch.groups.airdate ?? "", fixedDate);
  }
  function parseAirDateMatch(match, simpleTitle) {
    return parseAirDateGroups(requireGroups(match), simpleTitle);
  }
  function parseSeasonEpisodeMatch(match, simpleTitle) {
    return parseSeasonEpisodeGroups(requireGroups(match), simpleTitle);
  }
  function parseSeasonPackMatch(match, simpleTitle) {
    return parseSeasonPackGroups(requireGroups(match), simpleTitle);
  }
  function parsePartialSeasonMatch(match, simpleTitle) {
    return parsePartialSeasonGroups(requireGroups(match), simpleTitle);
  }
  function parseAbsoluteEpisodeMatch(match, simpleTitle) {
    return parseAbsoluteEpisodeGroups(requireGroups(match), simpleTitle);
  }
  function requireGroups(match) {
    const { groups } = match;
    if (groups === undefined) {
      throw new Error("No match");
    }
    return groups;
  }
  function parseAirDateGroups(groups, simpleTitle) {
    const { result } = createBaseResult(groups, simpleTitle);
    let lastTokenIndex = indexOfEnd(simpleTitle, groupValue(groups, "title") ?? "");
    const airYearText = groupValue(groups, "airyear");
    const airMonthText = groupValue(groups, "airmonth");
    const airDayText = groupValue(groups, "airday");
    if (!airYearText || !airMonthText || !airDayText) {
      return null;
    }
    const airYear = Number.parseInt(airYearText, 10);
    let airMonth = Number.parseInt(airMonthText, 10);
    let airDay = Number.parseInt(airDayText, 10);
    if (airMonth > 12) {
      const tempDay = airDay;
      airDay = airMonth;
      airMonth = tempDay;
    }
    const airDate = new Date(airYear, airMonth - 1, airDay);
    if (!isValidAirDate(airDate, airYear, airMonth, airDay)) {
      return null;
    }
    lastTokenIndex = Math.max(indexOfEnd(simpleTitle, airYearText), lastTokenIndex);
    lastTokenIndex = Math.max(indexOfEnd(simpleTitle, airMonthText), lastTokenIndex);
    lastTokenIndex = Math.max(indexOfEnd(simpleTitle, airDayText), lastTokenIndex);
    result.airDate = airDate;
    return finishResult(result, simpleTitle, lastTokenIndex);
  }
  function parseSeasonEpisodeGroups(groups, simpleTitle) {
    const { result, lastTokenIndex } = createBaseResult(groups, simpleTitle);
    const nextIndex = applySeasonNumbers(result, groups, simpleTitle, lastTokenIndex);
    const episodeResult = applyEpisodeNumbers(result, groups, simpleTitle, nextIndex);
    if (episodeResult === null) {
      return null;
    }
    return finishResult(result, simpleTitle, episodeResult);
  }
  function parseSeasonPackGroups(groups, simpleTitle) {
    const { result, lastTokenIndex } = createBaseResult(groups, simpleTitle);
    const nextIndex = applySeasonNumbers(result, groups, simpleTitle, lastTokenIndex);
    if (groupValue(groups, "extras")) {
      result.isSeasonExtra = true;
    }
    result.fullSeason = true;
    return finishResult(result, simpleTitle, nextIndex);
  }
  function parsePartialSeasonGroups(groups, simpleTitle) {
    const { result, lastTokenIndex } = createBaseResult(groups, simpleTitle);
    const nextIndex = applySeasonNumbers(result, groups, simpleTitle, lastTokenIndex);
    const seasonPart = groupValue(groups, "seasonpart");
    if (seasonPart) {
      result.seasonPart = Number.parseInt(seasonPart, 10);
      result.isPartialSeason = true;
    } else {
      result.fullSeason = true;
    }
    return finishResult(result, simpleTitle, nextIndex);
  }
  function parseAbsoluteEpisodeGroups(groups, simpleTitle) {
    const { result, lastTokenIndex } = createBaseResult(groups, simpleTitle);
    let nextIndex = applySeasonNumbers(result, groups, simpleTitle, lastTokenIndex);
    const episodeResult = applyEpisodeNumbers(result, groups, simpleTitle, nextIndex);
    if (episodeResult === null) {
      return null;
    }
    nextIndex = episodeResult;
    const absoluteResult = applyAbsoluteEpisodeNumbers(result, groups);
    if (absoluteResult === null) {
      return null;
    }
    if (absoluteResult.lastCapture) {
      nextIndex = Math.max(indexOfEnd(simpleTitle, absoluteResult.lastCapture), nextIndex);
    }
    return finishResult(result, simpleTitle, nextIndex);
  }
  function createBaseResult(groups, simpleTitle) {
    const title = groupValue(groups, "title") ?? "";
    const seriesName = title.replaceAll(".", " ").replaceAll("_", " ").replace(requestInfoExp, "").trim();
    return {
      result: {
        seriesName
      },
      lastTokenIndex: indexOfEnd(simpleTitle, title)
    };
  }
  function applySeasonNumbers(result, groups, simpleTitle, lastTokenIndex) {
    let nextIndex = lastTokenIndex;
    let seasons = [groupValue(groups, "season"), groupValue(groups, "season1")].filter(isPresent).map((x) => {
      nextIndex = Math.max(indexOfEndAfter(simpleTitle, x, nextIndex), nextIndex);
      return Number(x);
    });
    if (seasons.length > 1) {
      seasons = completeRange(seasons);
    }
    result.seasonNumbers = seasons;
    if (seasons.length > 1) {
      result.isMultiSeason = true;
    }
    return nextIndex;
  }
  function applyEpisodeNumbers(result, groups, simpleTitle, lastTokenIndex) {
    const episodeCaptures = [groupValue(groups, "episode"), groupValue(groups, "episode1")].filter(isPresent);
    if (episodeCaptures.length === 0) {
      return lastTokenIndex;
    }
    const first = parseEpisodeNumber(episodeCaptures[0]);
    const last = parseEpisodeNumber(episodeCaptures[episodeCaptures.length - 1]);
    const range = expandIntegerRange(first, last);
    if (range === null) {
      return null;
    }
    result.episodeNumbers = range;
    let nextIndex = lastTokenIndex;
    for (const episodeCapture of episodeCaptures) {
      nextIndex = Math.max(indexOfEndAfter(simpleTitle, episodeCapture, nextIndex), nextIndex);
    }
    return nextIndex;
  }
  function applyAbsoluteEpisodeNumbers(result, groups) {
    const absoluteEpisodeCaptures = [
      groupValue(groups, "absoluteepisode"),
      groupValue(groups, "absoluteepisode1")
    ].filter(isPresent);
    if (absoluteEpisodeCaptures.length === 0) {
      return {};
    }
    const first = Number(absoluteEpisodeCaptures[0]);
    const lastCapture = absoluteEpisodeCaptures[absoluteEpisodeCaptures.length - 1] ?? "";
    const last = Number(lastCapture);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
      return null;
    }
    if (first % 1 !== 0 || last % 1 !== 0) {
      if (absoluteEpisodeCaptures.length !== 1) {
        return null;
      }
      result.episodeNumbers = [first];
      result.isSpecial = true;
      return { lastCapture };
    }
    const range = expandIntegerRange(first, last);
    if (range === null) {
      return null;
    }
    result.episodeNumbers = range;
    if (groupValue(groups, "special")) {
      result.isSpecial = true;
    }
    return { lastCapture };
  }
  function finishResult(result, simpleTitle, lastTokenIndex) {
    const releaseTokens = lastTokenIndex === simpleTitle.length || lastTokenIndex === -1 ? simpleTitle : simpleTitle.slice(lastTokenIndex);
    const remainder = result.episodeNumbers !== undefined && result.episodeNumbers.length > 0 ? parseRemainder(releaseTokens) : undefined;
    return {
      ...result,
      releaseTokens,
      ...remainder ? { remainder } : {},
      seriesTitle: result.seriesName
    };
  }
  function parseRemainder(releaseTokens) {
    const rawRemainder = releaseTokens.replace(trailingRemainderRequestInfoExp, "").replace(releaseGroupSuffixExp, "").replace(leadingRemainderSeparatorsExp, "");
    if (leadingReleaseMetadataExp.test(rawRemainder)) {
      return;
    }
    const remainder = releaseTitleCleaner(rawRemainder);
    return remainder !== null && remainderContentExp.test(remainder) ? remainder : undefined;
  }
  function groupValue(groups, name) {
    const value = groups[name];
    return value === undefined || value.length === 0 ? undefined : value;
  }
  function isPresent(value) {
    return value !== undefined;
  }
  function parseEpisodeNumber(capture) {
    const wordIndex = episodeNumberWords.indexOf(capture.toLowerCase());
    return wordIndex === -1 ? Number(capture) : wordIndex;
  }
  function expandIntegerRange(first, last) {
    if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) {
      return null;
    }
    return Array.from({ length: last - first + 1 }, (_, index) => index + first);
  }
  function isValidAirDate(airDate, airYear, airMonth, airDay) {
    if (Number.isNaN(airDate.getTime())) {
      return false;
    }
    if (airDate.getFullYear() !== airYear || airDate.getMonth() !== airMonth - 1 || airDate.getDate() !== airDay) {
      return false;
    }
    if (airDate.getTime() > Date.now()) {
      return false;
    }
    return airDate.getTime() >= new Date(1970, 1, 1).getTime();
  }
  function indexOfEnd(str1, str2) {
    if (str2.length === 0) {
      return -1;
    }
    const io = str1.indexOf(str2);
    return io === -1 ? -1 : io + str2.length;
  }
  function indexOfEndAfter(str1, str2, startIndex) {
    if (str2.length === 0) {
      return -1;
    }
    const io = str1.indexOf(str2, Math.max(0, startIndex));
    return io === -1 ? -1 : io + str2.length;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/season/patterns.js
  var airDate = (name, regex) => ({
    name,
    regex,
    stopOnNull: true,
    parse: parseAirDateMatch
  });
  var seasonEpisode = (name, regex) => ({
    name,
    regex,
    parse: parseSeasonEpisodeMatch
  });
  var seasonPack = (name, regex) => ({
    name,
    regex,
    parse: parseSeasonPackMatch
  });
  var partialSeason = (name, regex) => ({
    name,
    regex,
    parse: parsePartialSeasonMatch
  });
  var absoluteEpisode = (name, regex) => ({
    name,
    regex,
    parse: parseAbsoluteEpisodeMatch
  });
  var seasonPatterns = [
    airDate("daily-airdate-no-title", /^(?<airyear>19[6-9]\d|20\d\d)(?<sep>[-_]?)(?<airmonth>0\d|1[0-2])\k<sep>(?<airday>[0-2]\d|3[01])(?!\d)/i),
    seasonEpisode("multi-part-no-title", /^(?:\W*S?(?<season>(?<!\d+)(?:\d{1,2}|\d{4})(?!\d+))(?:(?:[ex]){1,2}(?<episode>\d{1,3}(?!\d+)))+){2,}/i),
    seasonEpisode("multi-episode-single-episode-numbers", /^(?<title>[^\r\n]+?)[-_. ]S(?<season>(?<!\d+)(?:\d{1,2}|\d{4})(?!\d+))(?:[E-_. ]?[ex]?(?<episode>(?<!\d+)\d{1,2}(?!\d+)))+(?:[-_. ]?[ex]?(?<episode1>(?<!\d+)\d{1,2}(?!\d+)))+/i),
    seasonEpisode("multi-episode-with-title-and-trailing-info", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+S?(?<season>(?<!\d+)(?:\d{1,2})(?!\d+))(?:[ex]|\W[ex]|_){1,2}(?<episode>\d{2,3}(?!\d+))(?:(?:-|[ex]|\W[ex]|_){1,2}(?<episode1>\d{2,3}(?!\d+)))+)[^[\]\r\n]*(?:\[[^\]\r\n]+\])(?!\\)/i),
    seasonEpisode("multi-episode-no-title", /(?:S?(?<season>(?<!\d+)(?:\d{1,2}|\d{4})(?!\d+))(?:(?:[-_]|[ex]){1,2}(?<episode>\d{2,3}(?!\d+))){2,})/i),
    seasonEpisode("single-episode-no-title", /^(?:S?(?<season>(?<!\d+)(?:\d{1,2}|\d{4})(?!\d+))(?:(?:[-_ ]?[ex])(?<episode>\d{2,3}(?!\d+))))/i),
    absoluteEpisode("anime-subgroup-title-episode-absolute", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)(?<title>[^\r\n]+?)[-_. ](?:Episode)(?:[-_. ]+(?<absoluteepisode>(?<!\d+)\d{2,3}(\.\d{1,2})?(?!\d+)))+[-_. ]*(?<hash>\[\w{8}\])?(?:$|\.)?/i),
    absoluteEpisode("anime-subgroup-absolute-plus-season-episode", /^(?:\[(?<subgroup>[^\]\r\n]+)\](?:_|-|\s|\.)?)(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+(?<absoluteepisode>\d{2,3}(\.\d{1,2})?))+(?:_|-|\s|\.)+(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]|\W[ex]){1,2}(?<episode>\d{2}(?!\d+)))+)[^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-subgroup-season-episode-plus-absolute", /^(?:\[(?<subgroup>[^\]\r\n]+)\](?:_|-|\s|\.)?)(?<title>[^\r\n]+?)(?:[-_\W](?<![()[!]))+(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]|\W[ex]){1,2}(?<episode>\d{2}(?!\d+)))+)(?:(?:_|-|\s|\.)+(?<absoluteepisode>(?<!\d+)\d{2,3}(\.\d{1,2})?(?!\d+)))+[^\r\n]*(?:$|\.)/i),
    seasonEpisode("anime-subgroup-season-episode", /^(?:\[(?<subgroup>[^\]\r\n]+)\](?:_|-|\s|\.)?)(?<title>[^\r\n]+?)(?:[-_\W](?<![()[!]))+(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:[ex]|\W[ex]){1,2}(?<episode>\d{2}(?!\d+)))+)(?:\s|\.)[^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-subgroup-title-with-trailing-number", /^\[(?<subgroup>[^\]\r\n]+)\][-_. ]?(?<title>[^-\r\n]*?\d+)[-_. ]+(?:[-_. ]?(?<absoluteepisode>\d{3}(\.\d{1,2})?(?!\d+)))+(?:[-_. ]+(?<special>special|ova|ovd))?[^\r\n]*(?:$|\.mkv)/i),
    absoluteEpisode("anime-subgroup-title-dash-absolute", /^\[(?<subgroup>[^\]\r\n]+)\][-_. ]?(?<title>[^\r\n]+?)(?:[. ]-[. ](?<absoluteepisode>\d{2,3}(\.\d{1,2})?(?!\d+|[-])))+(?:[-_. ]+(?<special>special|ova|ovd))?[^\r\n]*(?:$|\.mkv)/i),
    absoluteEpisode("anime-subgroup-title-absolute", /^\[(?<subgroup>[^\]\r\n]+)\][-_. ]?(?<title>[^\r\n]+?)[-_. ]+\(?(?:[-_. ]?#?(?<absoluteepisode>\d{2,3}(\.\d{1,2})?(?!\d+)))+\)?(?:[-_. ]+(?<special>special|ova|ovd))?[^\r\n]*(?:$|\.mkv)/i),
    seasonEpisode("multi-episode-repeated", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+S?(?<season>(?<!\d+)(?:\d{1,2}|\d{4})(?!\d+))(?:(?:[ex]|[-_. ]e){1,2}(?<episode>\d{1,3}(?!\d+)))+){2,}/i),
    seasonEpisode("single-episode-with-title", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+S?(?<season>(?<!\d+)(?:\d{1,2})(?!\d+))(?:[ex]|\W[ex]|_){1,2}(?<episode>(?!265|264)\d{2,3}(?!\d+|(?:[ex]|\W[ex]|_|-){1,2})))/i),
    absoluteEpisode("anime-title-season-episode-plus-absolute-subgroup", /^(?<title>[^\r\n]+?)(?:[-_\W](?<![()[!]))+(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:[ex]|\W[ex]){1,2}(?<episode>(?<!\d+)\d{2}(?!\d+))))(?:[-_. ]+(?<absoluteepisode>(?<!\d+)\d{3}(\.\d{1,2})?(?!\d+)))+[^[\]\r\n]*\[(?<subgroup>[^\]\r\n]+)\](?:$|\.mkv)/i),
    absoluteEpisode("anime-title-episode-absolute-subgroup", /^(?<title>[^\r\n]+?)[-_. ]Episode(?:[-_. ]+(?<absoluteepisode>\d{2,3}(\.\d{1,2})?(?!\d+)))+[^[\]\r\n]*\[(?<subgroup>[^\]\r\n]+)\][^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-title-absolute-subgroup-hash", /^(?<title>[^\r\n]+?)(?:(?:_|-|\s|\.)+(?<absoluteepisode>\d{3}(\.\d{1,2})(?!\d+)))+[^[\]\r\n]*\[(?<subgroup>[^\]\r\n]+)\][^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-absolute-ep-range", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)(?:_|\s|\.)+(?:e|ep)(?<absoluteepisode>\d{2,3}(\.\d{1,2})?)-(?<absoluteepisode1>(?<!\d+)\d{1,2}(\.\d{1,2})?(?!\d+|-))[^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-absolute-number-range", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)[_. ]+(?<absoluteepisode>(?<!\d+)\d{1,2}(\.\d{1,2})?(?!\d+))-(?<absoluteepisode1>(?<!\d+)\d{1,2}(\.\d{1,2})?(?!\d+|-))[-_. ]*(?<hash>\[\w{8}\])?(?:$|\.)?/i),
    absoluteEpisode("anime-title-absolute-hash", /^(?<title>[^\r\n]+?)(?:(?:_|-|\s|\.)+(?<absoluteepisode>\d{2,3}(\.\d{1,2})?(?!\d+)))+(?:[-_. ]+(?<special>special|ova|ovd))?[-_. ]+[^[\]\r\n]*(?<hash>\[\w{8}\])(?:$|\.)/i),
    seasonEpisode("airdate-plus-season-episode", /^(?<title>[^\r\n]+?)?\W*(?<airdate>\d{4}\W+[0-1][0-9]\W+[0-3][0-9])(?!\W+[0-3][0-9])[-_. ](?:s?(?<season>(?<!\d+)(?:\d{1,2})(?!\d+)))(?:[ex](?<episode>(?<!\d+)(?:\d{1,3})(?!\d+)))/i),
    airDate("airdate-and-season-episode", /^(?<title>[^\r\n]+?)?\W*(?<airyear>\d{4})\W+(?<airmonth>[0-1][0-9])\W+(?<airday>[0-3][0-9])(?!\W+[0-3][0-9])[^\r\n]*?(?:s?(?<season>(?<!\d+)(?:\d{1,2})(?!\d+)))(?:[ex](?<episode>(?<!\d+)(?:\d{1,3})(?!\d+)))/i),
    seasonEpisode("four-digit-season-s-episode", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+S(?<season>(?<!\d+)(?:\d{4})(?!\d+))(?:e|\We|_){1,2}(?<episode>\d{2,3}(?!\d+))(?:(?:-|e|\We|_){1,2}(?<episode1>\d{2,3}(?!\d+)))*)\W?(?!\\)/i),
    seasonEpisode("four-digit-season-x-episode", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+(?<season>(?<!\d+)(?:\d{4})(?!\d+))(?:x|\Wx){1,2}(?<episode>\d{2,3}(?!\d+))(?:(?:-|x|\Wx|_){1,2}(?<episode1>\d{2,3}(?!\d+)))*)\W?(?!\\)/i),
    seasonPack("multi-season-pack", /^(?<title>[^\r\n]+?)[-_. ]+S(?<season>(?<!\d+)(?:\d{1,2})(?!\d+))\W?-\W?S?(?<season1>(?<!\d+)(?:\d{1,2})(?!\d+))/i),
    partialSeason("partial-season-pack", /^(?<title>[^\r\n]+?)(?:\W+S(?<season>(?<!\d+)(?:\d{1,2})(?!\d+))\W+(?:(?:Part\W?|(?<!\d+\W+)e)(?<seasonpart>\d{1,2}(?!\d+)))+)/i),
    seasonEpisode("miniseries-year-title-part-number", /^(?<title>[^\r\n]+?\d{4})(?:\W+(?:(?:Part\W?|e)(?<episode>\d{1,2}(?!\d+)))+)/i),
    seasonEpisode("miniseries-multi-episode", /^(?<title>[^\r\n]+?)(?:[-._ ][e])(?<episode>\d{2,3}(?!\d+))(?:(?:-?[e])(?<episode1>\d{2,3}(?!\d+)))+/i),
    seasonEpisode("miniseries-part-number", /^(?<title>[^\r\n]+?)(?:\W+(?:(?:Part\W?|(?<!\d+\W+)e)(?<episode>\d{1,2}(?!\d+)))+)/i),
    seasonEpisode("miniseries-part-word", /^(?<title>[^\r\n]+?)(?:\W+(?:Part[-._ ](?<episode>One|Two|Three|Four|Five|Six|Seven|Eight|Nine)(?:[-._ ]|$)))/i),
    seasonEpisode("miniseries-x-of-y", /^(?<title>[^\r\n]+?)(?:\W+(?:(?<episode>(?<!\d+)\d{1,2}(?!\d+))of\d+)+)/i),
    seasonEpisode("season-episode-words", /^(?<title>[^\r\n]*?)(?:[-_\W](?<![()[]))+(?:\W?Season\W?)(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:\W|_)+(?:Episode\W)(?:[-_. ]?(?<episode>(?<!\d+)\d{1,2}(?!\d+)))+/i),
    seasonEpisode("multi-episode-square-brackets", /^(?<title>[^\r\n]*?)[-._ ]+\[S(?<season>(?<!\d+)\d{2}(?!\d+))(?:[E-]{1,2}(?<episode>(?<!\d+)\d{2}(?!\d+)))+\]/i),
    seasonEpisode("multi-episode-no-space-before-season", /^(?<title>[^\r\n]*?)S(?<season>(?<!\d+)\d{2}(?!\d+))(?:E(?<episode>(?<!\d+)\d{2}(?!\d+)))+/i),
    seasonEpisode("single-episode-ep-label", /^(?<title>[^\r\n]*?)(?:\W?|_)S(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:\W|_)?Ep?[ ._]?(?<episode>(?<!\d+)\d{1,2}(?!\d+))/i),
    seasonEpisode("three-digit-season", /^(?<title>[^\r\n]*?)(?:\W?|_)S(?<season>(?<!\d+)\d{3}(?!\d+))(?:\W|_)?E(?<episode>(?<!\d+)\d{1,2}(?!\d+))/i),
    seasonEpisode("five-digit-episode-with-title", /^(?:(?<title>[^\r\n]+?)(?:_|-|\s|\.)+)(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+)))(?:(?:-|[ex]|\W[ex]|_){1,2}(?<episode>(?<!\d+)\d{5}(?!\d+)))/i),
    seasonEpisode("five-digit-multi-episode-with-title", /^(?:(?<title>[^\r\n]+?)(?:_|-|\s|\.)+)(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+)))(?:(?:[-_. ]{1,3}ep){1,2}(?<episode>(?<!\d+)\d{5}(?!\d+)))+/i),
    seasonEpisode("separated-season-and-episode", /^(?<title>[^\r\n]+?)(?:_|-|\s|\.)+S(?<season>\d{2}(?!\d+))(\W-\W)E(?<episode>(?<!\d+)\d{2}(?!\d+))(?!\\)/i),
    absoluteEpisode("anime-title-with-season-number-absolute", /^(?<title>[^\r\n]+?S\d{1,2})[-_. ]{3,}(?:EP)?(?<absoluteepisode>\d{2,3}(\.\d{1,2})?(?!\d+|[-]))/i),
    absoluteEpisode("anime-french-title-single-episode", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)[-_. ]+(?:Episode[-_. ]+)(?<absoluteepisode>\d{1}(\.\d{1,2})?(?!\d+))/i),
    seasonPack("season-only", /^(?<title>[^\r\n]+?)\W(?:S|Season)\W?(?<season>\d{1,2}(?!\d+))(\W+|_|$)(?<extras>EXTRAS|SUBPACK)?(?!\\)/i),
    seasonPack("four-digit-season-only", /^(?<title>[^\r\n]+?)\W(?:S|Season)\W?(?<season>\d{4}(?!\d+))(\W+|_|$)(?<extras>EXTRAS|SUBPACK)?(?!\\)/i),
    seasonEpisode("season-episode-square-brackets", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+\[S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]|\W[ex]|_){1,2}(?<episode>(?<!\d+)\d{2}(?!\d+|i|p)))+\])\W?(?!\\)/i),
    seasonEpisode("three-digit-episode-numbering", /^(?<title>[^\r\n]+?)?(?:(?:[_.](?<![()[!]))+(?<season>(?<!\d+)[1-9])(?<episode>[1-9][0-9]|[0][1-9])(?![a-z]|\d+))+(?:[_.]|$)/i),
    seasonEpisode("four-digit-episode-number-no-title", /^(?:S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]|\W[ex]|_){1,2}(?<episode>\d{4}(?!\d+|i|p)))+)(\W+|_|$)(?!\\)/i),
    seasonEpisode("four-digit-episode-number-with-title", /^(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]|\W[ex]|_){1,2}(?<episode>\d{4}(?!\d+|i|p)))+)\W?(?!\\)/i),
    airDate("ymd-airdate", /^(?<title>[^\r\n]+?)?\W*(?<airyear>\d{4})[-_. ]+(?<airmonth>[0-1][0-9])[-_. ]+(?<airday>[0-3][0-9])(?![-_. ]+[0-3][0-9])/i),
    airDate("mdy-airdate", /^(?<title>[^\r\n]+?)?\W*(?<airmonth>[0-1][0-9])[-_. ]+(?<airday>[0-3][0-9])[-_. ]+(?<airyear>\d{4})(?!\d+)/i),
    seasonEpisode("four-digit-scene-numbering", /^(?<title>[^\r\n]+?)?(?:(?:[-_\W](?<![()[!]))*(?<season>(?<!\d+|\(|\[|e|x)\d{2})(?<episode>(?<!e|x)\d{2}(?!p|i|\d+|\)|\]|\W\d+|\W(?:e|ep|x)\d+)))+(\W+|_|$)(?!\\)/i),
    seasonEpisode("single-digit-episode", /^(?<title>[^\r\n]*?)(?:(?:[-_\W](?<![()[!]))+S?(?<season>(?<!\d+)\d{1,2}(?!\d+))(?:(?:-|[ex]){1,2}(?<episode>\d{1}))+)+(\W+|_|$)(?!\\)/i),
    seasonEpisode("itunes-season-folder", /^(?:Season(?:_|-|\s|\.)(?<season>(?<!\d+)\d{1,2}(?!\d+)))(?:_|-|\s|\.)(?<episode>(?<!\d+)\d{1,2}(?!\d+))/i),
    seasonEpisode("itunes-season-episode", /^(?:(?<season>(?<!\d+)(?:\d{1,2})(?!\d+))(?:-(?<episode>\d{2,3}(?!\d+))))/i),
    absoluteEpisode("anime-absolute-ep-label", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)(?:(?:_|-|\s|\.)+(?:e|ep)(?<absoluteepisode>\d{2,4}(\.\d{1,2})?))+[^\r\n]*(?:$|\.)/i),
    absoluteEpisode("anime-title-episode-absolute", /^(?<title>[^\r\n]+?)[-_. ](?:Episode)(?:[-_. ]+(?<absoluteepisode>(?<!\d+)\d{2,3}(\.\d{1,2})?(?!\d+)))+[-_. ]*(?<hash>\[\w{8}\])?(?:$|\.)?/i),
    absoluteEpisode("anime-title-absolute-number", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)(?:[-_. ]+(?<absoluteepisode>(?<!\d+)\d{2,3}(\.\d{1,2})?(?!\d+)))+[-_. ]*(?<hash>\[\w{8}\])?(?:$|\.)?/i),
    absoluteEpisode("anime-title-braced-absolute-number", /^(?:\[(?<subgroup>[^\]\r\n]+)\][-_. ]?)?(?<title>[^\r\n]+?)(?:(?:[-_\W](?<![()[!]))+(?<absoluteepisode>(?<!\d+)\d{2,3}(\.\d{1,2})?(?!\d+)))+[-_. ]*(?<hash>\[\w{8}\])?(?:$|\.)?/i),
    seasonEpisode("extant-multi-episode-numbering", /^(?<title>[^\r\n]+?)[-_. ](?<season>[0]?\d?)(?:(?<episode>\d{2}){2}(?!\d+))[-_. ]/i)
  ];
  var rejectedPatterns = [
    /^[0-9a-zA-Z]{32}/i,
    /^[a-z0-9]{24}$/i,
    /^[A-Z]{11}\d{3}$/,
    /^[a-z]{12}\d{3}$/,
    /^Backup_\d{5,}S\d{2}-\d{2}$/i,
    /^123$/,
    /^abc$/i,
    /^abc[-_. ]xyz/i,
    /^b00bs$/i,
    /^\d{6}_\d{2}$/
  ];

  // node_modules/@ctrl/video-filename-parser/dist/src/season/index.js
  function parseSeason(title) {
    if (!preValidation(title)) {
      return null;
    }
    const simpleTitle = normalizeSixDigitAirDate(title, simplifyTitle(title));
    for (const pattern of seasonPatterns) {
      const match = pattern.regex.exec(simpleTitle);
      if (!match?.groups) {
        continue;
      }
      const result = pattern.parse(match, simpleTitle);
      if (result === null) {
        if (pattern.stopOnNull === true) {
          return null;
        }
        continue;
      }
      return toSeason(title, result);
    }
    return null;
  }
  function preValidation(title) {
    for (const exp of rejectedPatterns) {
      const match = exp.exec(title);
      if (match !== null) {
        return false;
      }
    }
    return true;
  }
  function toSeason(title, result) {
    const isSpecialFullSeason = result.fullSeason === true && result.releaseTokens !== undefined && /Special/i.test(result.releaseTokens);
    return {
      releaseTitle: title,
      seriesTitle: result.seriesName,
      seasons: result.seasonNumbers ?? [],
      episodeNumbers: result.episodeNumbers ?? [],
      ...result.remainder ? { remainder: result.remainder } : {},
      airDate: result.airDate ?? null,
      fullSeason: isSpecialFullSeason ? false : result.fullSeason ?? false,
      isPartialSeason: result.isPartialSeason ?? false,
      isMultiSeason: result.isMultiSeason ?? false,
      isSeasonExtra: result.isSeasonExtra ?? false,
      isSpecial: isSpecialFullSeason || (result.isSpecial ?? false),
      seasonPart: result.seasonPart ?? 0
    };
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/utils.js
  function removeEmpty(obj) {
    const result = {};
    for (const key in obj) {
      const value = obj[key];
      if (value != null) {
        result[key] = value;
      }
    }
    return result;
  }

  // node_modules/@ctrl/video-filename-parser/dist/src/filenameParse.js
  function filenameParse(name, isTv = false) {
    const titleAndYear = parseTitleAndYear(name);
    const parsedTitle = titleAndYear.title;
    let title = "";
    let year = null;
    if (!isTv) {
      title = titleAndYear.title;
      year = titleAndYear.year;
    }
    const edition = parseEdition(name, parsedTitle);
    const { codec: videoCodec } = parseVideoCodec(name);
    const { codec: audioCodec } = parseAudioCodec(name);
    const { channels: audioChannels } = parseAudioChannels(name);
    const group = parseGroup(name, parsedTitle);
    const { languages, multi } = parseLanguageInfo(name, parsedTitle);
    const quality = parseQuality(name, videoCodec);
    const complete = isComplete(name);
    const result = {
      title,
      year,
      resolution: quality.resolution,
      sources: quality.sources,
      videoCodec,
      audioCodec,
      audioChannels,
      modifier: quality.modifier ?? undefined,
      revision: quality.revision,
      group,
      edition,
      languages,
      multi,
      complete
    };
    if (isTv) {
      const season = parseSeason(name);
      if (season !== null) {
        const seasonResult = {
          seasons: season.seasons,
          episodeNumbers: season.episodeNumbers,
          ...season.remainder ? { remainder: season.remainder } : {},
          airDate: season.airDate,
          fullSeason: season.fullSeason,
          isPartialSeason: season.isPartialSeason,
          isMultiSeason: season.isMultiSeason,
          isSeasonExtra: season.isSeasonExtra,
          isSpecial: season.isSpecial,
          seasonPart: season.seasonPart
        };
        return {
          ...result,
          title: season.seriesTitle ?? title,
          ...seasonResult,
          isTv: true
        };
      }
    }
    return removeEmpty(result);
  }

  // src/util.ts
  function yearOf(date) {
    const year = date ? Number(date.slice(0, 4)) : NaN;
    return Number.isFinite(year) ? year : undefined;
  }
  function nonEmpty(text) {
    return text?.trim() || undefined;
  }
  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function fileName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function dirName(path) {
    return path.slice(0, path.lastIndexOf("/"));
  }
  function stripExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }
  function extension(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  // src/parse.ts
  var ID_TAG = /[[{]\s*(tmdb|tmdbid|imdb|imdbid|tvdb|tvdbid)\s*[-=]\s*([a-z0-9]+)\s*[\]}]/gi;
  var SEASON_DIR = /^(?:season|series|staffel|saison|temporada)[ ._-]*(\d{1,3})$|^s(\d{1,3})$/i;
  var SPECIALS_DIR = /^specials?$/i;
  var EPISODE_MARKER = /(?:^|[^a-z0-9])S\d{1,3}[ ._-]?E\d{1,4}(?![0-9])|(?:^|[^a-z0-9])\d{1,2}x\d{2,4}(?![0-9])/i;
  var LEADING_EPISODE = /^(?:e|ep|episode)?[ ._-]*(\d{1,4})(?![0-9])/i;
  var PAREN_YEAR = /^(.*?)[ ._-]*[([]((?:19|20)\d{2})[)\]]$/;
  var GENERIC_NAME = /^(?:movie|film|video|feature|main|title|vts_\d+_\d+|index|\d+)$/i;
  function parsePath(path) {
    const parts = path.split("/").filter(Boolean);
    const dirs = parts.slice(0, -1);
    const ids = {};
    const name = takeIds(stripExtension(parts[parts.length - 1] ?? ""), ids);
    const parentName = dirs[dirs.length - 1] ?? "";
    const grandName = dirs[dirs.length - 2] ?? "";
    const parent = takeIds(parentName, ids);
    const grand = takeIds(grandName, ids);
    const dirPath = (count) => "/" + dirs.slice(0, count).join("/");
    const folderSeason = seasonOfDir(parent);
    const layout = folderSeason !== undefined && grand ? { showDir: dirPath(dirs.length - 1), seasonDir: dirPath(dirs.length) } : {};
    if (EPISODE_MARKER.test(name)) {
      const parsed = filenameParse(spaceSeparated(name), true);
      if ("isTv" in parsed && parsed.seasons.length > 0 && parsed.episodeNumbers.length > 0) {
        const fromName = splitYear(parsed.title);
        const fromFolder = splitYear(folderSeason !== undefined ? grand : parent);
        const own = fromName.title ? fromName : fromFolder;
        return {
          kind: "episode",
          title: own.title,
          year: own.year ?? (fromName.title ? undefined : fromFolder.year),
          season: parsed.seasons[0],
          episodes: parsed.episodeNumbers,
          ids,
          ...layout
        };
      }
    }
    if (folderSeason !== undefined && grand) {
      const leading = LEADING_EPISODE.exec(name);
      if (leading) {
        const show = splitYear(grand);
        return {
          kind: "episode",
          title: show.title,
          year: show.year,
          season: folderSeason,
          episodes: [Number(leading[1])],
          ids,
          ...layout
        };
      }
    }
    const movie = parseMovieName(name);
    if (!movie.title || GENERIC_NAME.test(movie.title)) {
      return { kind: "movie", ...parseMovieName(parent), episodes: [], ids };
    }
    return { kind: "movie", ...movie, episodes: [], ids };
  }
  function parseMovieName(name) {
    const parsed = filenameParse(spaceSeparated(name));
    const title = parsed.title.trim();
    if (parsed.year)
      return { title, year: Number(parsed.year) };
    return splitYear(title);
  }
  function takeIds(name, ids) {
    return name.replace(ID_TAG, (_, source, value) => {
      const key = source.toLowerCase().replace(/id$/, "");
      if (key === "tmdb" && ids.tmdb === undefined && /^\d+$/.test(value))
        ids.tmdb = Number(value);
      if (key === "tvdb" && ids.tvdb === undefined && /^\d+$/.test(value))
        ids.tvdb = Number(value);
      if (key === "imdb" && ids.imdb === undefined && /^tt\d+$/i.test(value))
        ids.imdb = value.toLowerCase();
      return " ";
    }).replace(/\s+/g, " ").trim();
  }
  function seasonOfDir(name) {
    if (SPECIALS_DIR.test(name))
      return 0;
    const match = SEASON_DIR.exec(name);
    if (!match)
      return;
    return Number(match[1] ?? match[2]);
  }
  function splitYear(text) {
    const match = PAREN_YEAR.exec(text.trim());
    if (!match)
      return { title: text.trim() };
    return { title: match[1].trim(), year: Number(match[2]) };
  }
  function spaceSeparated(name) {
    if (/[\s.]/.test(name))
      return name;
    return name.replace(/[-_]+/g, " ");
  }
  // Info.json
  var Info_default = {
    name: "Metadata",
    identifier: "io.github.thepushkarp.iina-metadata",
    version: "0.1.0",
    ghRepo: "thepushkarp/iina-metadata",
    ghVersion: 1,
    description: "Identifies movies and TV episodes like Infuse (TMDB, with TVmaze for TV) and saves the details into MKV/MP4 files and as .nfo and artwork files next to them.",
    author: {
      name: "Pushkar Patel",
      url: "https://github.com/thepushkarp"
    },
    entry: "dist/index.js",
    permissions: [
      "show-osd",
      "network-request",
      "file-system"
    ],
    allowedDomains: [
      "api.themoviedb.org",
      "image.tmdb.org",
      "api.tvmaze.com",
      "static.tvmaze.com"
    ],
    sidebarTab: {
      name: "Metadata"
    },
    preferencesPage: "pref.html",
    preferenceDefaults: {
      auto_identify: true,
      show_osd: true,
      set_media_title: true,
      language: "",
      embed_enabled: true,
      embed_cover: true,
      embed_landscape_cover: true,
      embed_people: true,
      embed_ids: true,
      embed_content_rating: true,
      sidecar_enabled: true,
      sidecar_nfo: true,
      sidecar_poster: true,
      sidecar_fanart: true,
      sidecar_episode_thumb: true,
      sidecar_show_level: true,
      sidecar_style: "infuse",
      existing_files: "replace",
      artwork_size: "standard",
      mkvtoolnix_dir: "",
      atomicparsley_path: ""
    }
  };

  // src/prefs.ts
  var defaultPrefs = Info_default.preferenceDefaults;
  function readPrefs() {
    const prefs = { ...defaultPrefs };
    for (const key of Object.keys(defaultPrefs)) {
      const value = iina.preferences.get(key);
      if (value !== undefined && value !== null)
        prefs[key] = value;
    }
    return prefs;
  }
  function tmdbLanguage(preference, systemLocalizations) {
    if (preference.trim())
      return preference.trim();
    const system = systemLocalizations[0] ?? "en-US";
    return system.replace(/^zh-Hans$/, "zh-CN").replace(/^zh-Hant$/, "zh-TW");
  }

  // src/storage.ts
  var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var MATCHES = "@data/matches.json";
  async function ensureDataDirs() {
    const dirs = ["@data/cache", "@data/backups"].map((dir) => iina.utils.resolvePath(dir));
    const result = await iina.utils.exec("/bin/mkdir", ["-p", ...dirs]);
    if (result.status !== 0)
      throw new Error(`Creating ${dirs.join(", ")} failed: ${result.stderr}`);
  }
  function fnv1a(text) {
    let hash = 2166136261;
    for (let i = 0;i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  function cachedGetJson(get) {
    return async (url, params = {}, headers) => {
      const key = url + "?" + Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join("&");
      const path = `@data/cache/${fnv1a(key)}.json`;
      if (iina.file.exists(path)) {
        const entry = JSON.parse(iina.file.read(path) ?? "null");
        if (entry && entry.key === key && Date.now() - entry.savedAt < CACHE_TTL_MS)
          return entry.body;
      }
      const body = await get(url, params, headers);
      iina.file.write(path, JSON.stringify({ key, savedAt: Date.now(), body }));
      return body;
    };
  }
  function readMatches() {
    if (!iina.file.exists(MATCHES))
      return {};
    return JSON.parse(iina.file.read(MATCHES) ?? "{}");
  }
  function rememberedMatch(path) {
    return readMatches()[path];
  }
  function rememberMatch(path, ref) {
    const matches = readMatches();
    matches[path] = ref;
    iina.file.write(MATCHES, JSON.stringify(matches, null, 1));
  }

  // src/tools.ts
  var HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
  var INSTALL_HINT = {
    mkvtoolnix: "Install MKVToolNix with `brew install mkvtoolnix`, or set its folder in the plugin settings.",
    atomicParsley: "Install AtomicParsley with `brew install atomicparsley`, or set its path in the plugin settings."
  };
  function findTools(mkvtoolnixDir, atomicParsleyPath) {
    const inDirs = (dirs, name) => dirs.map((dir) => `${dir.replace(/\/$/, "")}/${name}`).find((path) => iina.file.exists(path));
    const mkvDirs = mkvtoolnixDir ? [mkvtoolnixDir] : HOMEBREW_DIRS;
    return {
      mkvpropedit: inDirs(mkvDirs, "mkvpropedit"),
      mkvmerge: inDirs(mkvDirs, "mkvmerge"),
      mkvextract: inDirs(mkvDirs, "mkvextract"),
      atomicParsley: atomicParsleyPath ? iina.file.exists(atomicParsleyPath) ? atomicParsleyPath : undefined : inDirs(HOMEBREW_DIRS, "AtomicParsley")
    };
  }
  async function run(path, args) {
    try {
      return await iina.utils.exec(path, args);
    } catch (error) {
      throw new Error(`Couldn't start ${path}: ${String(error)}`);
    }
  }
  function tail(result, lines = 3) {
    return (result.stderr + `
` + result.stdout).split(`
`).map((line) => line.trim()).filter(Boolean).slice(-lines).join(" · ");
  }

  // src/writers/mkv.ts
  function simples(entries) {
    return entries.filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => ({ name, value: String(value) }));
  }
  function matroskaTags(meta, prefs) {
    const item = simples([
      ["TITLE", meta.title],
      ["DATE_RELEASED", meta.releaseDate ?? meta.year],
      ["DESCRIPTION", meta.overview],
      ["SYNOPSIS", meta.overview],
      ...meta.genres.map((genre) => ["GENRE", genre]),
      ["LAW_RATING", prefs.embed_content_rating ? meta.contentRating : undefined]
    ]);
    if (prefs.embed_people) {
      item.push(...simples(meta.directors.map((name) => ["DIRECTOR", name])));
      item.push(...simples(meta.writers.map((name) => ["WRITTEN_BY", name])));
      item.push(...actors(meta.cast));
    }
    const ids = prefs.embed_ids;
    if (meta.kind === "movie") {
      if (ids)
        item.push(...simples([["TMDB", tmdbTag(meta)], ["IMDB", meta.ids.imdb]]));
      return document([tag(50, item)]);
    }
    const show = simples([
      ["TITLE", meta.show.title],
      ["DATE_RELEASED", meta.show.premiered],
      ...ids ? [
        ["TMDB", tmdbTag(meta)],
        ["IMDB", meta.show.ids.imdb],
        ["TVDB2", meta.show.ids.tvdb ? `series/${meta.show.ids.tvdb}` : undefined]
      ] : []
    ]);
    const episode = [
      ...simples([["PART_NUMBER", meta.episodes[0]]]),
      ...item,
      ...ids ? simples([
        ["IMDB", meta.ids.imdb],
        ["TVDB2", meta.ids.tvdb ? `episodes/${meta.ids.tvdb}` : undefined]
      ]) : []
    ];
    return document([tag(70, show), tag(60, simples([["PART_NUMBER", meta.season]])), tag(50, episode)]);
  }
  function actors(cast) {
    return cast.map((member) => ({
      name: "ACTOR",
      value: member.name,
      children: member.character ? [{ name: "CHARACTER", value: member.character }] : undefined
    }));
  }
  function document(tags) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Tags SYSTEM "matroskatags.dtd">
<Tags>
${tags.join(`
`)}
</Tags>
`;
  }
  function tag(level, content) {
    return [
      "  <Tag>",
      `    <Targets><TargetTypeValue>${level}</TargetTypeValue></Targets>`,
      ...content.map((simple) => simpleXml(simple, "    ")),
      "  </Tag>"
    ].join(`
`);
  }
  function simpleXml(simple, indent) {
    const head = `${indent}<Simple><Name>${escapeXml(simple.name)}</Name><String>${escapeXml(simple.value)}</String>`;
    if (!simple.children)
      return `${head}</Simple>`;
    const children = simple.children.map((child) => simpleXml(child, indent + "  "));
    return `${head}
${children.join(`
`)}
${indent}</Simple>`;
  }
  function mkvpropeditArgs(file, title, tagsPath, attachments, existingAttachmentNames) {
    const args = [file, "--edit", "info", "--set", `title=${title}`, "--tags", `global:${tagsPath}`];
    for (const attachment of attachments) {
      args.push("--attachment-name", attachment.name, "--attachment-mime-type", attachment.mimeType);
      if (existingAttachmentNames.includes(attachment.name)) {
        args.push("--replace-attachment", `name:${attachment.name.replace(/:/g, "\\c")}:${attachment.path}`);
      } else {
        args.push("--add-attachment", attachment.path);
      }
    }
    return args;
  }
  function parseMkvmergeIdentify(json) {
    const info = JSON.parse(json);
    return {
      attachmentNames: (info.attachments ?? []).map((attachment) => attachment.file_name),
      hasGlobalTags: (info.global_tags ?? []).some((entry) => entry.num_entries > 0)
    };
  }

  // src/writers/mp4.ts
  var ATOMICPARSLEY_RATINGS = new Set([
    "G",
    "PG",
    "PG-13",
    "R",
    "NC-17",
    "Unrated",
    "TV-Y",
    "TV-Y7",
    "TV-G",
    "TV-PG",
    "TV-14",
    "TV-MA"
  ]);
  var SHORT_DESCRIPTION_BYTES = 255;
  function atomicParsleyArgs(file, meta, prefs, coverPath) {
    const args = [file, "--overWrite"];
    const add = (flag, value) => {
      if (value !== undefined && value !== "")
        args.push(flag, String(value));
    };
    const addCustom = (name, value) => {
      if (value)
        args.push("--rDNSatom", value, `name=${name}`, "domain=com.apple.iTunes");
    };
    add("--title", meta.title);
    add("--year", meta.releaseDate ? `${meta.releaseDate}T00:00:00Z` : meta.year);
    if (meta.overview) {
      add("--description", truncateUtf8(meta.overview, SHORT_DESCRIPTION_BYTES));
      add("--longdesc", meta.overview);
    }
    add("--genre", meta.genres[0]);
    if (meta.kind === "movie") {
      add("--stik", "Movie");
    } else {
      add("--stik", "TV Show");
      add("--TVShowName", meta.show.title);
      add("--TVSeasonNum", meta.season);
      add("--TVEpisodeNum", meta.episodes[0]);
      add("--TVEpisode", episodeCode(meta.season, meta.episodes));
      add("--TVNetwork", meta.show.network);
    }
    if (prefs.embed_content_rating && ATOMICPARSLEY_RATINGS.has(meta.contentRating ?? "")) {
      add("--contentRating", meta.contentRating);
    }
    if (coverPath)
      args.push("--artwork", "REMOVE_ALL", "--artwork", coverPath);
    if (prefs.embed_people)
      addCustom("iTunMOVI", castPlist(meta));
    if (prefs.embed_ids) {
      addCustom("TMDB", tmdbTag(meta));
      addCustom("IMDB", meta.kind === "movie" ? meta.ids.imdb : meta.show.ids.imdb);
    }
    return args;
  }
  function castPlist(meta) {
    const sections = [
      ["cast", meta.cast.map((member) => member.name)],
      ["directors", meta.directors],
      ["screenwriters", meta.writers]
    ];
    const people = sections.filter(([, names]) => names.length > 0).map(([key, names]) => {
      const entries = names.map((name) => `<dict><key>name</key><string>${escapeXml(name)}</string></dict>`);
      return `<key>${key}</key><array>${entries.join("")}</array>`;
    }).join("");
    const studio = meta.studios[0] ? `<key>studio</key><string>${escapeXml(meta.studios[0])}</string>` : "";
    if (!people && !studio)
      return;
    return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' + people + studio + "</dict></plist>";
  }
  function truncateUtf8(text, maxBytes) {
    const ellipsis = "…";
    if (utf8Length(text) <= maxBytes)
      return text;
    let bytes = utf8Length(ellipsis);
    let result = "";
    for (const char of text) {
      bytes += utf8Length(char);
      if (bytes > maxBytes)
        break;
      result += char;
    }
    return result.trimEnd() + ellipsis;
  }
  function utf8Length(text) {
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    }
    return bytes;
  }

  // src/writers/nfo.ts
  var HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
  function movieNfo(meta) {
    return document2("movie", [
      element("title", meta.title),
      element("originaltitle", meta.originalTitle),
      element("year", meta.year),
      element("premiered", meta.releaseDate),
      element("tagline", meta.tagline),
      element("plot", meta.overview),
      element("runtime", meta.runtimeMinutes),
      element("mpaa", meta.contentRating),
      ratings(meta.rating),
      ...meta.genres.map((genre) => element("genre", genre)),
      ...meta.directors.map((name) => element("director", name)),
      ...meta.writers.map((name) => element("credits", name)),
      ...meta.studios.map((name) => element("studio", name)),
      ...actors2(meta.cast),
      ...uniqueIds(meta.ids)
    ]);
  }
  function episodeNfo(meta) {
    return document2("episodedetails", [
      element("title", meta.title),
      element("showtitle", meta.show.title),
      element("season", meta.season),
      element("episode", meta.episodes[0]),
      element("aired", meta.releaseDate),
      element("plot", meta.overview),
      element("runtime", meta.runtimeMinutes),
      element("mpaa", meta.contentRating),
      ratings(meta.rating),
      ...meta.directors.map((name) => element("director", name)),
      ...meta.writers.map((name) => element("credits", name)),
      ...actors2(meta.cast),
      ...uniqueIds(meta.ids)
    ]);
  }
  function showNfo(show) {
    return document2("tvshow", [
      element("title", show.title),
      element("originaltitle", show.originalTitle),
      element("year", show.year),
      element("premiered", show.premiered),
      element("plot", show.overview),
      element("mpaa", show.contentRating),
      ratings(show.rating),
      ...show.genres.map((genre) => element("genre", genre)),
      element("studio", show.network),
      ...actors2(show.cast),
      ...uniqueIds(show.ids)
    ]);
  }
  function document2(root, children) {
    const body = children.filter(Boolean).map((child) => `  ${child}
`).join("");
    return `${HEADER}
<${root}>
${body}</${root}>
`;
  }
  function element(name, value) {
    if (value === undefined || value === "")
      return "";
    return `<${name}>${escapeXml(String(value))}</${name}>`;
  }
  function ratings(rating) {
    if (rating === undefined)
      return "";
    return `<ratings><rating name="default" max="10" default="true"><value>${rating.toFixed(1)}</value></rating></ratings>`;
  }
  function actors2(cast) {
    return cast.map((member, order) => `<actor>${element("name", member.name)}${element("role", member.character)}<order>${order}</order></actor>`);
  }
  function uniqueIds(ids) {
    const entries = [
      ["tmdb", ids.tmdb],
      ["imdb", ids.imdb],
      ["tvdb", ids.tvdb],
      ["tvmaze", ids.tvmaze]
    ];
    const present = entries.filter(([, value]) => value !== undefined);
    return present.map(([type, value], index) => `<uniqueid type="${type}"${index === 0 ? ' default="true"' : ""}>${escapeXml(String(value))}</uniqueid>`);
  }

  // src/writers/sidecars.ts
  function planSidecars(videoPath, meta, layout, prefs) {
    const base = `${dirName(videoPath)}/${stripExtension(fileName(videoPath))}`;
    const kodi = prefs.sidecar_style === "kodi";
    const result = [];
    const addText = (enabled, label, path, content) => {
      if (enabled)
        result.push({ type: "text", label, path, content: content() });
    };
    const addImage = (enabled, label, pathWithoutExt, image) => {
      if (enabled && image)
        result.push({ type: "image", label, path: pathWithoutExt + extensionOf(image), image });
    };
    if (meta.kind === "movie") {
      addText(prefs.sidecar_nfo, "Movie NFO", `${base}.nfo`, () => movieNfo(meta));
      addImage(prefs.sidecar_poster, "Poster", kodi ? `${base}-poster` : base, meta.poster);
      addImage(prefs.sidecar_fanart, "Fanart", `${base}-fanart`, meta.backdrop);
      return result;
    }
    addText(prefs.sidecar_nfo, "Episode NFO", `${base}.nfo`, () => episodeNfo(meta));
    addImage(prefs.sidecar_episode_thumb, "Episode thumbnail", kodi ? `${base}-thumb` : base, meta.still);
    const { showDir, seasonDir } = layout;
    if (!prefs.sidecar_show_level || !showDir || !seasonDir)
      return result;
    const seasonName = !kodi ? fileName(seasonDir) : meta.season === 0 ? "season-specials" : `season${String(meta.season).padStart(2, "0")}`;
    addText(prefs.sidecar_nfo, "Show NFO", `${showDir}/tvshow.nfo`, () => showNfo(meta.show));
    addImage(prefs.sidecar_poster, "Show poster", `${showDir}/poster`, meta.show.poster);
    addImage(prefs.sidecar_poster, "Season poster", `${showDir}/${seasonName}-poster`, meta.seasonPoster);
    addImage(prefs.sidecar_fanart, "Show fanart", `${showDir}/fanart`, meta.show.backdrop);
    return result;
  }
  function extensionOf(image) {
    return /\.png$/i.test(image.original) ? ".png" : ".jpg";
  }

  // src/save.ts
  var MKV_EXTENSIONS = new Set(["mkv", "mka", "mk3d", "webm"]);
  var MP4_EXTENSIONS = new Set(["mp4", "m4v"]);
  function buildPlan(videoPath, meta, query, prefs) {
    const items = [];
    let embed;
    if (prefs.embed_enabled) {
      const planned = planEmbed(videoPath, meta, prefs);
      items.push(planned.item);
      embed = planned.job;
    }
    const sidecars = [];
    if (prefs.sidecar_enabled) {
      const videoDir = dirName(videoPath);
      for (const sidecar of planSidecars(videoPath, meta, query, prefs)) {
        const exists = iina.file.exists(sidecar.path);
        const item = { label: sidecar.label, target: relativePath(videoDir, sidecar.path), action: "write" };
        if (exists && prefs.existing_files === "skip") {
          item.action = "skip";
          item.detail = "Already exists; kept because of your settings.";
        } else if (exists) {
          item.action = "replace";
          item.detail = "The current file goes to the Trash.";
        }
        sidecars.push({ sidecar, item });
        items.push(item);
      }
    }
    return { items, embed, sidecars };
  }
  function planEmbed(videoPath, meta, prefs) {
    const target = fileName(videoPath);
    const type = extension(target);
    const container = MKV_EXTENSIONS.has(type) ? "mkv" : MP4_EXTENSIONS.has(type) ? "mp4" : undefined;
    const unavailable = (detail) => ({
      item: { label: "Embed in file", target, action: "unavailable", detail }
    });
    if (!container)
      return unavailable(`Tags can't be embedded in .${type} files; sidecar files still work.`);
    const tools = findTools(prefs.mkvtoolnix_dir.trim(), prefs.atomicparsley_path.trim());
    const ready = container === "mkv" ? tools.mkvpropedit && tools.mkvmerge && tools.mkvextract : tools.atomicParsley;
    if (!ready)
      return unavailable(container === "mkv" ? INSTALL_HINT.mkvtoolnix : INSTALL_HINT.atomicParsley);
    const cover = prefs.embed_cover ? meta.poster : undefined;
    const landscapeCover = container === "mkv" && prefs.embed_landscape_cover ? (meta.kind === "episode" ? meta.still : undefined) ?? meta.backdrop : undefined;
    const item = {
      label: "Embed in file",
      target,
      action: "write",
      detail: embedSummary(container, meta, prefs, Boolean(cover), Boolean(landscapeCover))
    };
    return { item, job: { container, tools, cover, landscapeCover, item } };
  }
  function embedSummary(container, meta, prefs, cover, landscapeCover) {
    const parts = ["title", "overview", "release date", "genres"];
    if (meta.kind === "episode")
      parts.push("show, season & episode");
    if (prefs.embed_people)
      parts.push("cast & crew");
    if (prefs.embed_ids)
      parts.push("database ids");
    if (prefs.embed_content_rating && meta.contentRating)
      parts.push("content rating");
    if (cover)
      parts.push("cover");
    if (landscapeCover)
      parts.push("landscape cover");
    const tool = container === "mkv" ? "mkvpropedit, in place" : "AtomicParsley";
    return `${parts.join(", ")} (${tool})`;
  }
  function relativePath(dir, path) {
    if (path.startsWith(dir + "/"))
      return path.slice(dir.length + 1);
    const parent = dirName(dir);
    if (parent && path.startsWith(parent + "/"))
      return "../" + path.slice(parent.length + 1);
    return path;
  }
  async function executePlan(plan, videoPath, meta, prefs) {
    const results = [];
    const attempt = async (item, write) => {
      try {
        results.push({ label: item.label, target: item.target, ok: true, message: await write() });
      } catch (error) {
        results.push({ label: item.label, target: item.target, ok: false, message: errorText(error) });
      }
    };
    const download = downloader(prefs);
    const job = plan.embed;
    if (job) {
      await attempt(job.item, () => job.container === "mkv" ? embedMkv(videoPath, meta, job, prefs, download) : embedMp4(videoPath, meta, job, prefs, download));
    }
    for (const { sidecar, item } of plan.sidecars) {
      await attempt(item, () => writeSidecar(sidecar, prefs, download));
    }
    return results;
  }
  function downloader(prefs) {
    const done = new Map;
    return async (image) => {
      const url = prefs.artwork_size === "original" ? image.original : image.standard;
      const cached = done.get(url);
      if (cached)
        return cached;
      const tmp = `@tmp/img-${fnv1a(url)}${extensionOf(image)}`;
      await iina.http.download(url, tmp);
      if (!iina.file.exists(tmp))
        throw new Error(`Downloading ${url} failed`);
      const path = iina.utils.resolvePath(tmp);
      done.set(url, path);
      return path;
    };
  }
  async function embedMkv(videoPath, meta, job, prefs, download) {
    const { mkvmerge, mkvextract, mkvpropedit } = job.tools;
    const identified = await run(mkvmerge, ["-J", videoPath]);
    if (identified.status !== 0)
      throw new Error(`mkvmerge couldn't read the file: ${tail(identified)}`);
    const info = parseMkvmergeIdentify(identified.stdout);
    const notes = [];
    const backup = `@data/backups/${fnv1a(videoPath)}.xml`;
    if (info.hasGlobalTags && !iina.file.exists(backup)) {
      const extracted = await run(mkvextract, [videoPath, "tags", iina.utils.resolvePath(backup)]);
      if (extracted.status > 1)
        throw new Error(`Backing up existing tags failed: ${tail(extracted)}`);
      notes.push(`previous tags backed up to ${iina.utils.resolvePath(backup)}`);
    }
    const tagsPath = `@tmp/tags-${fnv1a(videoPath)}.xml`;
    iina.file.write(tagsPath, matroskaTags(meta, prefs));
    const attachments = [];
    for (const [name, image] of [["cover", job.cover], ["cover_land", job.landscapeCover]]) {
      if (!image)
        continue;
      const type = extensionOf(image);
      attachments.push({ name: name + type, path: await download(image), mimeType: type === ".png" ? "image/png" : "image/jpeg" });
    }
    const edited = await run(mkvpropedit, mkvpropeditArgs(videoPath, displayTitle(meta), iina.utils.resolvePath(tagsPath), attachments, info.attachmentNames));
    if (edited.status > 1)
      throw new Error(`mkvpropedit failed: ${tail(edited)}`);
    if (edited.status === 1)
      notes.push(`warnings: ${tail(edited)}`);
    return ["Tags and covers written", ...notes].join("; ");
  }
  async function embedMp4(videoPath, meta, job, prefs, download) {
    const coverPath = job.cover ? await download(job.cover) : undefined;
    const result = await run(job.tools.atomicParsley, atomicParsleyArgs(videoPath, meta, prefs, coverPath));
    if (result.status !== 0 || /AtomicParsley error/i.test(result.stdout + result.stderr)) {
      throw new Error(`AtomicParsley failed: ${tail(result)}`);
    }
    return "Tags and cover written";
  }
  async function writeSidecar(sidecar, prefs, download) {
    const exists = iina.file.exists(sidecar.path);
    if (exists && prefs.existing_files === "skip")
      return "Kept the existing file";
    if (exists)
      iina.file.trash(sidecar.path);
    if (sidecar.type === "text") {
      iina.file.write(sidecar.path, sidecar.content);
    } else {
      const copied = await run("/bin/cp", [await download(sidecar.image), sidecar.path]);
      if (copied.status !== 0)
        throw new Error(`Copying artwork failed: ${tail(copied)}`);
    }
    if (!iina.file.exists(sidecar.path))
      throw new Error(`${sidecar.path} wasn't created`);
    return exists ? "Replaced (previous version in Trash)" : "Written";
  }

  // src/tmdb.ts
  var API = "https://api.themoviedb.org/3";
  var IMAGES = "https://image.tmdb.org/t/p/";
  var CAST_LIMIT = 15;

  class Tmdb {
    get;
    token;
    language;
    constructor(get, token, language) {
      this.get = get;
      this.token = token;
      this.language = language;
    }
    request(path, params = {}) {
      return this.get(API + path, { language: this.language, ...params }, { Authorization: `Bearer ${this.token}`, Accept: "application/json" });
    }
    async search(kind, title, year) {
      const movie = kind === "movie";
      const params = { query: title, include_adult: "false" };
      if (year)
        params[movie ? "year" : "first_air_date_year"] = String(year);
      const body = await this.request(movie ? "/search/movie" : "/search/tv", params);
      return (body.results ?? []).map((result) => ({
        provider: "tmdb",
        kind,
        id: result.id,
        title: movie ? result.title : result.name,
        originalTitle: movie ? result.original_title : result.original_name,
        year: yearOf(movie ? result.release_date : result.first_air_date),
        overview: nonEmpty(result.overview),
        poster: image(result.poster_path, "w185")?.standard,
        popularity: result.popularity
      }));
    }
    async find(source, externalId) {
      const body = await this.request(`/find/${encodeURIComponent(externalId)}`, { external_source: source });
      return { movie: body.movie_results?.[0]?.id, show: body.tv_results?.[0]?.id };
    }
    async movie(id) {
      const body = await this.request(`/movie/${id}`, {
        append_to_response: "credits,release_dates,external_ids"
      });
      return toMovieMetadata(body, this.country());
    }
    async episode(showId, season, episodes) {
      const [show, episode] = await Promise.all([
        this.request(`/tv/${showId}`, { append_to_response: "credits,content_ratings,external_ids" }),
        this.request(`/tv/${showId}/season/${season}/episode/${episodes[0]}`, {
          append_to_response: "credits,external_ids"
        })
      ]);
      return toEpisodeMetadata(show, episode, episodes, this.country());
    }
    country() {
      return /-([A-Z]{2})$/.exec(this.language)?.[1] ?? "US";
    }
  }
  function image(path, standardSize) {
    if (!path)
      return;
    return { standard: `${IMAGES}${standardSize}${path}`, original: `${IMAGES}original${path}` };
  }
  function castOf(credits) {
    return (credits?.cast ?? []).slice(0, CAST_LIMIT).map((person) => ({ name: person.name, character: nonEmpty(person.character) }));
  }
  function crewNames(crew, match) {
    const names = (crew ?? []).filter(match).map((member) => member.name);
    return [...new Set(names)];
  }
  var isDirector = (member) => member.job === "Director";
  var isWriter = (member) => member.department === "Writing";
  function toMovieMetadata(body, country) {
    const releases = body.release_dates?.results ?? [];
    const certification = releases.find((entry) => entry.iso_3166_1 === country)?.release_dates?.map((release) => release.certification).find((value) => value);
    return {
      kind: "movie",
      provider: "tmdb",
      title: body.title,
      originalTitle: body.original_title !== body.title ? body.original_title : undefined,
      year: yearOf(body.release_date),
      releaseDate: nonEmpty(body.release_date),
      overview: nonEmpty(body.overview),
      tagline: nonEmpty(body.tagline),
      genres: (body.genres ?? []).map((genre) => genre.name),
      rating: body.vote_count ? body.vote_average : undefined,
      contentRating: certification,
      runtimeMinutes: body.runtime || undefined,
      directors: crewNames(body.credits?.crew, isDirector),
      writers: crewNames(body.credits?.crew, isWriter),
      cast: castOf(body.credits),
      studios: (body.production_companies ?? []).map((company) => company.name),
      ids: {
        tmdb: body.id,
        imdb: nonEmpty(body.imdb_id ?? body.external_ids?.imdb_id)
      },
      poster: image(body.poster_path, "w780"),
      backdrop: image(body.backdrop_path, "w1280")
    };
  }
  function toEpisodeMetadata(showBody, episodeBody, episodes, country) {
    const show = {
      title: showBody.name,
      originalTitle: showBody.original_name !== showBody.name ? showBody.original_name : undefined,
      year: yearOf(showBody.first_air_date),
      premiered: nonEmpty(showBody.first_air_date),
      overview: nonEmpty(showBody.overview),
      genres: (showBody.genres ?? []).map((genre) => genre.name),
      rating: showBody.vote_count ? showBody.vote_average : undefined,
      contentRating: (showBody.content_ratings?.results ?? []).find((entry) => entry.iso_3166_1 === country)?.rating,
      network: showBody.networks?.[0]?.name,
      cast: castOf(showBody.credits),
      ids: {
        tmdb: showBody.id,
        imdb: nonEmpty(showBody.external_ids?.imdb_id),
        tvdb: showBody.external_ids?.tvdb_id ?? undefined
      },
      poster: image(showBody.poster_path, "w780"),
      backdrop: image(showBody.backdrop_path, "w1280")
    };
    const season = episodeBody.season_number;
    const seasonPoster = image((showBody.seasons ?? []).find((entry) => entry.season_number === season)?.poster_path, "w780");
    const crew = [...episodeBody.crew ?? [], ...episodeBody.credits?.crew ?? []];
    const episodeCast = castOf(episodeBody.credits);
    return {
      kind: "episode",
      provider: "tmdb",
      title: nonEmpty(episodeBody.name) ?? `Episode ${episodeBody.episode_number}`,
      year: yearOf(episodeBody.air_date),
      releaseDate: nonEmpty(episodeBody.air_date),
      overview: nonEmpty(episodeBody.overview),
      genres: show.genres,
      rating: episodeBody.vote_count ? episodeBody.vote_average : undefined,
      contentRating: show.contentRating,
      runtimeMinutes: episodeBody.runtime || undefined,
      directors: crewNames(crew, isDirector),
      writers: crewNames(crew, isWriter),
      cast: episodeCast.length > 0 ? episodeCast : show.cast,
      studios: show.network ? [show.network] : [],
      ids: {
        tmdb: episodeBody.id,
        imdb: nonEmpty(episodeBody.external_ids?.imdb_id),
        tvdb: episodeBody.external_ids?.tvdb_id ?? undefined
      },
      poster: seasonPoster ?? show.poster,
      backdrop: show.backdrop,
      show,
      season,
      episodes,
      seasonPoster,
      still: image(episodeBody.still_path, "original")
    };
  }

  // src/tvmaze.ts
  var API2 = "https://api.tvmaze.com";

  class Tvmaze {
    get;
    constructor(get) {
      this.get = get;
    }
    async searchShows(title) {
      const body = await this.get(`${API2}/search/shows`, { q: title });
      return body.map(({ show }) => ({
        provider: "tvmaze",
        kind: "episode",
        id: show.id,
        title: show.name,
        year: yearOf(show.premiered),
        overview: stripHtml(show.summary),
        poster: show.image?.medium ?? undefined,
        popularity: show.weight
      }));
    }
    async lookup(source, externalId) {
      try {
        const show = await this.get(`${API2}/lookup/shows`, { [source]: externalId });
        return show.id;
      } catch (error) {
        if (isNotFound(error))
          return;
        throw error;
      }
    }
    async episode(showId, season, episodes) {
      const [show, episode, seasons] = await Promise.all([
        this.get(`${API2}/shows/${showId}`, { embed: "cast" }),
        this.get(`${API2}/shows/${showId}/episodebynumber`, {
          season: String(season),
          number: String(episodes[0])
        }),
        this.get(`${API2}/shows/${showId}/seasons`)
      ]);
      return toEpisodeMetadata2(show, episode, seasons, episodes);
    }
  }
  function stripHtml(html) {
    if (!html)
      return;
    return nonEmpty(html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  function image2(value) {
    return value?.original ? { standard: value.original, original: value.original } : undefined;
  }
  function toEpisodeMetadata2(showBody, episodeBody, seasonsBody, episodes) {
    const network = showBody.network?.name ?? showBody.webChannel?.name;
    const show = {
      title: showBody.name,
      year: yearOf(showBody.premiered),
      premiered: showBody.premiered ?? undefined,
      overview: stripHtml(showBody.summary),
      genres: showBody.genres ?? [],
      rating: showBody.rating?.average ?? undefined,
      network,
      cast: (showBody._embedded?.cast ?? []).map((entry) => ({
        name: entry.person.name,
        character: entry.character?.name
      })),
      ids: {
        tvmaze: showBody.id,
        imdb: showBody.externals?.imdb ?? undefined,
        tvdb: showBody.externals?.thetvdb ?? undefined
      },
      poster: image2(showBody.image)
    };
    const seasonPoster = image2(seasonsBody.find((entry) => entry.number === episodeBody.season)?.image);
    return {
      kind: "episode",
      provider: "tvmaze",
      title: episodeBody.name || `Episode ${episodeBody.number}`,
      year: yearOf(episodeBody.airdate),
      releaseDate: episodeBody.airdate || undefined,
      overview: stripHtml(episodeBody.summary),
      genres: show.genres,
      rating: episodeBody.rating?.average ?? undefined,
      runtimeMinutes: episodeBody.runtime ?? undefined,
      directors: [],
      writers: [],
      cast: show.cast,
      studios: network ? [network] : [],
      ids: { tvmaze: episodeBody.id },
      poster: seasonPoster ?? show.poster,
      show,
      season: episodeBody.season,
      episodes,
      seasonPoster,
      still: image2(episodeBody.image)
    };
  }

  // src/index.ts
  var { console, core, event, menu, mpv, sidebar, utils } = iina;
  var KEYCHAIN_SERVICE = "tmdb";
  var KEYCHAIN_ACCOUNT = "api-read-access-token";
  var state = { phase: "idle", candidates: [], hasToken: false, plan: [], saving: false };
  var current;
  var generation = 0;
  var token = readToken();
  function readToken() {
    const stored = utils.keychainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return typeof stored === "string" && stored ? stored : undefined;
  }
  function providers() {
    const get = cachedGetJson(iinaGetJson);
    const language = tmdbLanguage(readPrefs().language, utils.preferredLocalizations());
    return { tmdb: token ? new Tmdb(get, token, language) : undefined, tvmaze: new Tvmaze(get) };
  }
  function send(name, data) {
    sidebar.postMessage(name, encodeURIComponent(JSON.stringify(data)));
  }
  function publish(patch) {
    state = { ...state, ...patch, hasToken: Boolean(token) };
    state.plan = current?.metadata && state.phase === "matched" ? buildPlan(current.path, current.metadata, current.query, readPrefs()).items : [];
    send("state", state);
  }
  function osd(message) {
    if (readPrefs().show_osd)
      core.osd(message);
  }
  function fileLoaded(url) {
    generation++;
    mpv.set("force-media-title", "");
    const reset = { metadata: undefined, confidence: undefined, via: undefined, candidates: [], message: undefined, results: undefined };
    if (core.status.isNetworkResource) {
      current = undefined;
      publish({ ...reset, phase: "unsupported", fileName: undefined, message: "Metadata lookup works for local files only." });
      return;
    }
    const path = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
    current = { path, query: parsePath(path) };
    publish({ ...reset, phase: "idle", fileName: fileName(path), query: current.query });
    if (readPrefs().auto_identify)
      runIdentify();
  }
  function showMatch(metadata, ref, confidence, via, candidates) {
    current = { ...current, metadata, ref };
    if (readPrefs().set_media_title)
      mpv.set("force-media-title", displayTitle(metadata));
    publish({ phase: "matched", metadata, confidence, via, candidates });
  }
  async function runIdentify() {
    if (!current)
      return;
    const gen = ++generation;
    const { path, query } = current;
    publish({ phase: "identifying", metadata: undefined, results: undefined, message: undefined });
    try {
      const result = await identify(query, providers(), { remembered: rememberedMatch(path), embedded: embeddedRef() });
      if (gen !== generation)
        return;
      if (result.status === "unmatched") {
        publish({ phase: "unmatched", message: result.reason, candidates: result.candidates });
        osd("No metadata match — search in the Metadata sidebar");
        return;
      }
      showMatch(result.metadata, result.ref, result.confidence, result.via, result.candidates);
      const title = displayTitle(result.metadata);
      osd(result.confidence === "high" ? `${title} — save it from the Metadata sidebar` : `Possible match: ${title} — please confirm`);
    } catch (error) {
      if (gen !== generation)
        return;
      console.error(`Identifying ${path} failed: ${errorText(error)}`);
      publish({ phase: "error", message: errorText(error) });
    }
  }
  function embeddedRef() {
    try {
      return parseTmdbTag(mpv.getString("metadata/by-key/TMDB"));
    } catch {
      return;
    }
  }
  async function choose({ candidate, season, episode }) {
    if (!current)
      return;
    const gen = ++generation;
    const { path, query } = current;
    const ref = { provider: candidate.provider, kind: candidate.kind, id: candidate.id };
    if (candidate.kind === "episode") {
      ref.season = season ?? query.season;
      ref.episodes = episode !== undefined ? [episode] : query.episodes;
      if (ref.season === undefined || ref.episodes.length === 0) {
        publish({ phase: "error", message: "Enter the season and episode number for this file." });
        return;
      }
    }
    publish({ phase: "identifying", results: undefined, message: undefined });
    try {
      const metadata = await fetchMetadata(ref, providers());
      if (gen !== generation)
        return;
      rememberMatch(path, ref);
      showMatch(metadata, ref, "high", "your choice", state.candidates);
    } catch (error) {
      if (gen !== generation)
        return;
      publish({ phase: "error", message: errorText(error) });
    }
  }
  async function save() {
    if (!current?.metadata || !current.ref || state.saving)
      return;
    const { path, query, metadata, ref } = current;
    publish({ saving: true, results: undefined });
    try {
      const prefs = readPrefs();
      const results = await executePlan(buildPlan(path, metadata, query, prefs), path, metadata, prefs);
      rememberMatch(path, ref);
      publish({ saving: false, results });
      const failed = results.filter((result) => !result.ok).length;
      osd(failed ? `Metadata saved with ${failed} problem(s) — see the sidebar` : "Metadata saved");
    } catch (error) {
      console.error(`Saving metadata for ${path} failed: ${errorText(error)}`);
      publish({ saving: false, results: [{ label: "Save", target: fileName(path), ok: false, message: errorText(error) }] });
    }
  }
  async function setToken(value) {
    try {
      await iinaGetJson("https://api.themoviedb.org/3/authentication", {}, { Authorization: `Bearer ${value}` });
      if (!utils.keychainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value)) {
        throw new Error("Saving the token to the Keychain failed.");
      }
      token = value;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }
  function setUpSidebar() {
    sidebar.loadFile("dist/ui/sidebar/index.html");
    sidebar.onMessage("ready", () => publish({}));
    sidebar.onMessage("identify", () => void runIdentify());
    sidebar.onMessage("save", () => void save());
    sidebar.onMessage("choose", (request) => void choose(request));
    sidebar.onMessage("open", ({ url }) => utils.open(url));
    sidebar.onMessage("search", async (request) => {
      let response;
      try {
        const found = await search(request.kind, request.title, request.year, providers());
        response = { candidates: rank(request, found).map((entry) => entry.candidate) };
      } catch (error) {
        response = { candidates: [], error: errorText(error) };
      }
      send("search-results", response);
    });
    sidebar.onMessage("set-token", async ({ token: value }) => {
      const response = await setToken(value.trim());
      send("token-result", response);
      if (response.ok)
        runIdentify();
      else
        publish({});
    });
    sidebar.onMessage("forget-token", () => {
      utils.keychainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, "");
      token = undefined;
      publish({});
    });
  }
  event.on("iina.window-loaded", setUpSidebar);
  event.on("iina.file-loaded", fileLoaded);
  menu.addItem(menu.item("Show Metadata", () => sidebar.show()));
  menu.addItem(menu.item("Identify Again", () => void runIdentify()));
  menu.addItem(menu.item("Save Metadata to File", () => void save()));
  ensureDataDirs().catch((error) => console.error(errorText(error)));
  if (core.window.loaded)
    setUpSidebar();
  if (!core.status.idle && core.status.url)
    fileLoaded(core.status.url);
})();
