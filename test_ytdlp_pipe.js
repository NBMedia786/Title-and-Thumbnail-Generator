import ytDlp from 'yt-dlp-exec';
import { spawn } from 'child_process';
import fs from 'fs';

const url = 'https://youtu.be/5krFR7DJyDA?si=d20l2pvEyto';
const time = 600; // 10 minutes in

async function test() {
    console.log(`Testing yt-dlp pipe for ${url} at ${time}s`);

    // Use exec so we get the child process
    const ytProcess = ytDlp.exec(url, {
        output: '-',
        downloadSections: `*${time}-${time + 5}`,
        format: 'bestvideo[height<=480]',
        quiet: true,
        noWarnings: true,
    }, {
        stdio: ['ignore', 'pipe', 'ignore'] // We only care about stdout
    });

    const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-frames:v', '1',
        '-f', 'image2',
        'test_pipe_output.jpg',
        '-y'
    ]);

    if (ytProcess.stdout) {
        ytProcess.stdout.pipe(ffmpeg.stdin);
    } else {
        console.error('No stdout from yt-dlp process');
    }

    ffmpeg.stderr.on('data', d => console.error('FF Error:', d.toString()));

    ffmpeg.on('close', (code) => {
        console.log(`FFmpeg process finished with code ${code}`);
        if (code === 0) console.log('Check test_pipe_output.jpg');
    });
}

test();
