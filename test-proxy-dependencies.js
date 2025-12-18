// Diagnostic script to test yt-dlp and ffmpeg availability
// Run this on your Hostinger VPS to diagnose issues

import { execSync, spawn } from 'child_process';
import ytDlpRaw from 'yt-dlp-exec';

console.log('=== YouTube Thumbnail Proxy Diagnostic ===\n');

// Test 1: Check if yt-dlp is in PATH
console.log('1. Testing yt-dlp availability...');
try {
    const ytdlpPath = execSync('which yt-dlp', { encoding: 'utf-8' }).trim();
    console.log('   ✅ yt-dlp found at:', ytdlpPath);

    const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf-8' }).trim();
    console.log('   ✅ yt-dlp version:', ytdlpVersion);
} catch (err) {
    console.log('   ❌ yt-dlp not found in PATH');
    console.log('   Error:', err.message);
}

// Test 2: Check if ffmpeg is in PATH
console.log('\n2. Testing ffmpeg availability...');
try {
    const ffmpegPath = execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
    console.log('   ✅ ffmpeg found at:', ffmpegPath);

    const ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -n 1', { encoding: 'utf-8', shell: '/bin/bash' }).trim();
    console.log('   ✅ ffmpeg version:', ffmpegVersion);
} catch (err) {
    console.log('   ❌ ffmpeg not found in PATH');
    console.log('   Error:', err.message);
}

// Test 3: Check Node.js environment PATH
console.log('\n3. Node.js PATH environment...');
console.log('   PATH:', process.env.PATH);

// Test 4: Test yt-dlp-exec library
console.log('\n4. Testing yt-dlp-exec library...');
try {
    console.log('   Testing with a sample YouTube URL...');
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    // Test basic info extraction
    const info = await ytDlpRaw(testUrl, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
    });

    console.log('   ✅ yt-dlp-exec works!');
    console.log('   Video title:', info.title);
    console.log('   Duration:', info.duration, 'seconds');
} catch (err) {
    console.log('   ❌ yt-dlp-exec failed');
    console.log('   Error:', err.message);
    console.log('   Stack:', err.stack);
}

// Test 5: Test yt-dlp.exec (for streaming)
console.log('\n5. Testing yt-dlp.exec (streaming mode)...');
try {
    if (typeof ytDlpRaw.exec === 'function') {
        console.log('   ✅ ytDlp.exec method exists');

        // Try to spawn a process
        const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const proc = ytDlpRaw.exec(testUrl, {
            dumpSingleJson: true,
            noWarnings: true,
        });

        let output = '';
        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('   ✅ ytDlp.exec spawned successfully');
                    const info = JSON.parse(output);
                    console.log('   Video title:', info.title);
                    resolve();
                } else {
                    reject(new Error(`Process exited with code ${code}`));
                }
            });
            proc.on('error', reject);
        });
    } else {
        console.log('   ❌ ytDlp.exec method not found');
    }
} catch (err) {
    console.log('   ❌ ytDlp.exec failed');
    console.log('   Error:', err.message);
}

// Test 6: Test actual thumbnail extraction
console.log('\n6. Testing thumbnail extraction (like the proxy endpoint)...');
try {
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const time = 10;
    const section = `*${time}-${time + 5}`;

    console.log(`   Attempting to extract frame at ${time}s...`);

    const ytProcess = ytDlpRaw.exec(testUrl, {
        output: '-',
        downloadSections: section,
        format: 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        quiet: true,
        noWarnings: true,
    }, {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrData = '';
    ytProcess.stderr.on('data', (d) => {
        stderrData += d.toString();
    });

    let stdoutSize = 0;
    ytProcess.stdout.on('data', (d) => {
        stdoutSize += d.length;
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ytProcess.kill();
            reject(new Error('Timeout after 30s'));
        }, 30000);

        ytProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 || stdoutSize > 0) {
                console.log('   ✅ Frame extraction successful!');
                console.log('   Downloaded:', stdoutSize, 'bytes');
                resolve();
            } else {
                reject(new Error(`Process exited with code ${code}\nStderr: ${stderrData}`));
            }
        });

        ytProcess.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
} catch (err) {
    console.log('   ❌ Frame extraction failed');
    console.log('   Error:', err.message);
}

console.log('\n=== Diagnostic Complete ===');
console.log('\nIf any tests failed, please share the output with me for troubleshooting.');
