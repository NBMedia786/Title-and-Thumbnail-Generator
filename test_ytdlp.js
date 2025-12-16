import ytDlp from 'yt-dlp-exec';

const url = 'https://youtu.be/5krFR7DJyDA?si=d20l2pvEyto';

async function test() {
    console.log('Testing yt-dlp-exec with URL:', url);
    try {
        const output = await ytDlp(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
        });
        console.log('Success! Title:', output.title);
        console.log('Stream URL:', output.url ? output.url.substring(0, 50) + '...' : 'Direct URL not found (check formats)');

        // Find best video-only format
        const format = output.formats.find(f => f.ext === 'mp4' && f.resolution === '720p') || output.formats[output.formats.length - 1];
        console.log('Selected format URL:', format.url.substring(0, 50) + '...');
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
