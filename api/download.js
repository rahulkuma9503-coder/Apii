const axios = require('axios');
const { Parser } = require('m3u8-parser');
const ffmpeg = require('fluent-ffmpeg');
const { tmpdir } = require('os');
const { join } = require('path');
const { createWriteStream, unlinkSync, existsSync, mkdirSync } = require('fs');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let url;
    
    if (req.method === 'POST') {
      url = req.body?.url;
    } else {
      url = req.query?.url;
    }

    if (!url) {
      return res.status(400).json({
        error: 'Missing URL parameter',
        usage: 'Send a POST request with { "url": "your_m3u8_url" } or GET with ?url=your_m3u8_url',
        example: 'https://your-vercel-app.vercel.app/api/download?url=https://media-cdn.classplusapp.com/.../master.m3u8'
      });
    }

    // Validate URL
    if (!url.includes('.m3u8')) {
      return res.status(400).json({ error: 'URL must be a valid .m3u8 stream' });
    }

    console.log('Processing URL:', url);

    // Get m3u8 content
    const response = await axios.get(url);
    const m3u8Content = response.data;

    // Parse m3u8
    const parser = new Parser();
    parser.push(m3u8Content);
    parser.end();

    const parsedManifest = parser.manifest;

    if (!parsedManifest.segments || parsedManifest.segments.length === 0) {
      return res.status(400).json({ error: 'No video segments found in the stream' });
    }

    // Get base URL for relative segment URLs
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

    // Create temporary files
    const tempDir = join(tmpdir(), 'classplus-dl');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const outputFile = join(tempDir, `lecture_${Date.now()}.mp4`);
    const segmentsListFile = join(tempDir, `segments_${Date.now()}.txt`);

    // Create segments list for ffmpeg
    const segmentsList = parsedManifest.segments
      .map(segment => {
        let segmentUrl = segment.uri;
        // Handle relative URLs
        if (!segmentUrl.startsWith('http')) {
          segmentUrl = baseUrl + segmentUrl;
        }
        return `file '${segmentUrl}'`;
      })
      .join('\n');

    require('fs').writeFileSync(segmentsListFile, segmentsList);

    // Set response headers for streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="lecture_${Date.now()}.mp4"`);

    // Use ffmpeg to concatenate and convert segments
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(segmentsListFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy', '-movflags frag_keyframe+empty_moov'])
        .format('mp4')
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          console.log(`Processing: ${progress.percent}% done`);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          // Clean up temp files
          try {
            if (existsSync(segmentsListFile)) unlinkSync(segmentsListFile);
            if (existsSync(outputFile)) unlinkSync(outputFile);
          } catch (e) {}
          reject(err);
        })
        .on('end', () => {
          console.log('Processing finished successfully');
          // Clean up temp files
          try {
            if (existsSync(segmentsListFile)) unlinkSync(segmentsListFile);
            if (existsSync(outputFile)) unlinkSync(outputFile);
          } catch (e) {}
          resolve();
        })
        .pipe(res, { end: true });
    });

  } catch (error) {
    console.error('Error:', error.message);
    
    // Provide specific error messages
    if (error.response) {
      if (error.response.status === 404) {
        return res.status(404).json({ error: 'Video not found. The URL might be expired or invalid.' });
      }
      if (error.response.status === 403) {
        return res.status(403).json({ error: 'Access forbidden. The video might be protected.' });
      }
    }
    
    return res.status(500).json({
      error: 'Failed to process video',
      message: error.message,
      tips: [
        'Ensure the m3u8 URL is accessible',
        'Check if the video requires authentication',
        'Try using a VPN if the content is region-locked'
      ]
    });
  }
};
