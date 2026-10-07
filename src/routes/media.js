'use strict';
// Homepage videos, managed by the restaurant's staff. Mounted by admin.js, so every route here has
// already passed requireStaff(['owner', 'admin']) for req.tenant.
//
//   GET    /api/admin/media                 hero + special video status for this restaurant
//   POST   /api/admin/media/:slot           multipart "video" -> encoded with ffmpeg -> Supabase Storage
//   DELETE /api/admin/media/:slot           remove the video (the page falls back to its poster / default)
//   GET    /api/admin/media/special-items   the five dishes shown in the Special section
//   PUT    /api/admin/media/special-items   { item_ids: [five different dish ids] }
//
// Slots: "hero" (plays at the top of the page) and "special" (the clip you scroll through beside the five
// Special dishes). Files are stored per restaurant: <tenant id>/<slot>.mp4 and <tenant id>/<slot>.jpg in the
// public "videos" bucket (create it in Supabase -> Storage, public, 5 MB file limit).

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// The ffmpeg program committed at the repository root. The path is fixed on purpose: no environment setting.
const FFMPEG_PATH = path.join(__dirname, '..', '..', 'ffmpeg');
const VIDEO_BUCKET = 'videos';
const TMP_DIR = path.join(os.tmpdir(), 'bitegrow-video-uploads');
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4_500_000;                 // the bucket refuses files of 5 MB or more
const ALLOWED_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
const SPECIAL_ITEM_COUNT = 5;

// How each slot is encoded. Both drop the audio and put the index first so playback starts before the download ends.
const SLOTS = {
  // Hero: keeps the picture quality (up to 720 px wide), trimmed to 6 s, plays by itself.
  hero: {
    seconds: 6,
    args: ['-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-maxrate', '6000k', '-bufsize', '12000k'],
  },
  // Special: small (360p) and every frame is a keyframe, so dragging or scrolling through it is smooth. 10 s.
  special: {
    seconds: 10,
    args: ['-vf', 'fps=30,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-b:v', '1200k', '-maxrate', '2500k', '-bufsize', '2500k',
      '-g', '1', '-keyint_min', '1', '-sc_threshold', '0'],
  },
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function defaultRunFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).split('\n').slice(-4).join('\n')));
      resolve();
    });
  });
}

function createMediaRouter({ supabase, onMediaChanged = () => {}, runFfmpeg = defaultRunFfmpeg, tmpDir = TMP_DIR, log = console }) {
  const router = express.Router();
  fs.mkdirSync(tmpDir, { recursive: true });
  try { fs.chmodSync(FFMPEG_PATH, 0o755); } catch (e) { /* best effort: the file may be missing in tests */ }

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: MAX_SOURCE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      return ALLOWED_EXT.includes(ext) ? cb(null, true) : cb(new Error(`Unsupported video type "${ext}". Allowed: ${ALLOWED_EXT.join(', ')}`));
    },
  });

  let busy = false;                                  // ffmpeg is heavy: one clip at a time per server

  const bucket = () => supabase.storage.from(VIDEO_BUCKET);
  const videoPath = (tenant, slot) => `${tenant.id}/${slot}.mp4`;
  const posterPath = (tenant, slot) => `${tenant.id}/${slot}.jpg`;
  const urlOf = (objectPath, version) => `${bucket().getPublicUrl(objectPath).data.publicUrl}?v=${Number(version) || 0}`;

  async function mediaRows(tenantId) {
    const { data, error } = await supabase.from('bg_tenant_media').select('slot, video_url, poster_url, version').eq('tenant_id', tenantId);
    if (error) throw error;
    return data || [];
  }
  const view = (rows) => Object.fromEntries(Object.keys(SLOTS).map((slot) => {
    const r = rows.find((x) => x.slot === slot);
    return [slot, r && r.video_url ? { video_url: r.video_url, poster_url: r.poster_url || null, version: r.version } : null];
  }));

  // Step in front of multer so an unknown slot or a busy server never leaves a temp file behind.
  const checkSlot = (req, res, next) => {
    if (!SLOTS[req.params.slot]) return res.status(404).json({ error: 'Unknown video slot' });
    next();
  };

  router.get('/', asyncHandler(async (req, res) => res.json(view(await mediaRows(req.tenant.id)))));

  router.post('/:slot', checkSlot, (req, res, next) => {
    if (busy) return res.status(409).json({ error: 'A video is already being processed. Please wait a moment.' });
    busy = true;
    upload.single('video')(req, res, (err) => {
      if (!err) return next();
      busy = false;
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      res.status(400).json({ error: tooBig ? 'The source video must be smaller than 300 MB.' : (err.message || 'Upload a single video in the "video" field') });
    });
  }, async (req, res) => {
    const tenant = req.tenant; const slot = req.params.slot; const cfg = SLOTS[slot];
    const source = req.file && req.file.path;
    const stamp = `${tenant.id}-${slot}-${Date.now()}`;
    const outVideo = path.join(tmpDir, `${stamp}.mp4`);
    const outPoster = path.join(tmpDir, `${stamp}.jpg`);
    try {
      if (!source) return res.status(400).json({ error: 'Choose a video file to upload' });

      await runFfmpeg(['-y', '-i', source, '-t', String(cfg.seconds), '-an', ...cfg.args, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outVideo]);
      if (fs.statSync(outVideo).size >= MAX_OUTPUT_BYTES) {
        return res.status(400).json({ error: 'The encoded video is larger than 4.5 MB. Use a shorter or simpler clip.' });
      }
      await runFfmpeg(['-y', '-i', outVideo, '-frames:v', '1', '-q:v', '3', outPoster]);     // poster = first frame, shown until the video loads

      const store = bucket();
      const poster = await store.upload(posterPath(tenant, slot), await fs.promises.readFile(outPoster), { contentType: 'image/jpeg', upsert: true, cacheControl: '3600' });
      if (poster.error) throw poster.error;
      const video = await store.upload(videoPath(tenant, slot), await fs.promises.readFile(outVideo), { contentType: 'video/mp4', upsert: true, cacheControl: '3600' });
      if (video.error) throw video.error;

      // The version in the saved links changes on every upload, so browsers fetch the new clip instead of an old cached one.
      const version = Date.now();
      const row = { tenant_id: tenant.id, slot, video_url: urlOf(videoPath(tenant, slot), version), poster_url: urlOf(posterPath(tenant, slot), version), version, updated_at: new Date().toISOString() };
      const { error } = await supabase.from('bg_tenant_media').upsert(row, { onConflict: 'tenant_id,slot' });
      if (error) throw error;
      onMediaChanged(tenant.id);
      res.json({ slot, video_url: row.video_url, poster_url: row.poster_url, version });
    } catch (err) {
      log.error(`[${tenant.slug}] video upload (${slot}) failed:`, err.message);
      const storage = /bucket|storage|object/i.test(err.message || '');
      res.status(storage ? 502 : 500).json({ error: storage ? 'Could not reach the "videos" storage bucket. Check that it exists and is public.' : 'Could not process this video. Try another MP4.' });
    } finally {
      await Promise.all([source, outVideo, outPoster].filter(Boolean).map((f) => fs.promises.unlink(f).catch(() => {})));
      busy = false;
    }
  });

  router.delete('/:slot', checkSlot, asyncHandler(async (req, res) => {
    const tenant = req.tenant; const slot = req.params.slot;
    const { error: rmErr } = await bucket().remove([videoPath(tenant, slot), posterPath(tenant, slot)]);
    if (rmErr) return res.status(502).json({ error: 'Could not reach the "videos" storage bucket.' });
    const { error } = await supabase.from('bg_tenant_media').delete().eq('tenant_id', tenant.id).eq('slot', slot);
    if (error) throw error;
    onMediaChanged(tenant.id);
    res.json(view(await mediaRows(tenant.id)));
  }));

  // ---- the five Special dishes ---------------------------------------------------------------
  const readFeatures = async (tenantId) => {
    const { data, error } = await supabase.from('bg_tenant_settings').select('features').eq('tenant_id', tenantId).maybeSingle();
    if (error) throw error;
    return (data && data.features) || {};
  };

  router.get('/special-items', asyncHandler(async (req, res) => {
    const ids = (await readFeatures(req.tenant.id)).specialItemIds;
    res.json({ item_ids: Array.isArray(ids) ? ids : [] });
  }));

  router.put('/special-items', asyncHandler(async (req, res) => {
    const raw = (req.body || {}).item_ids;
    const ids = Array.isArray(raw) ? raw.map(Number) : [];
    if (ids.length !== SPECIAL_ITEM_COUNT || ids.some((n) => !Number.isInteger(n) || n < 1) || new Set(ids).size !== SPECIAL_ITEM_COUNT) {
      return res.status(400).json({ error: `Choose ${SPECIAL_ITEM_COUNT} different dishes` });
    }
    const { data, error } = await supabase.from('bg_menu_items').select('id').eq('tenant_id', req.tenant.id).eq('is_available', true).in('id', ids);
    if (error) throw error;
    if ((data || []).length !== SPECIAL_ITEM_COUNT) return res.status(400).json({ error: 'Choose dishes from this restaurant\'s available menu' });

    const features = { ...(await readFeatures(req.tenant.id)), specialItemIds: ids };
    const { error: uErr } = await supabase.from('bg_tenant_settings').update({ features }).eq('tenant_id', req.tenant.id);
    if (uErr) throw uErr;
    onMediaChanged(req.tenant.id);
    res.json({ item_ids: ids });
  }));

  return router;
}

module.exports = { createMediaRouter, FFMPEG_PATH, SLOTS, SPECIAL_ITEM_COUNT };
