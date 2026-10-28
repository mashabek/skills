# projector

Plays a video inside a Claude Code pane, beside the chat, with sound. Paste a YouTube link,
any URL yt-dlp understands, or a local file path.

Where the terminal draws inline images (Ghostty, Kitty, WezTerm, iTerm2) the pane shows real
video frames. Elsewhere it draws colored pixel art from quadrant block characters, which works in
any terminal. Either way the picture fills the pane's width.

Tested with Claude Code 2.1.311 on macOS. Function hooks are early access, so a later release
may break it.

## Install

```bash
claude plugin marketplace add mashabek/skills
claude plugin install projector@skills
```

It needs `ffmpeg` (with `ffprobe`) and `yt-dlp` on the machine:

```bash
brew install ffmpeg yt-dlp
```

Sound plays through `afplay` on macOS, or `ffplay` where it is installed. Panes dock beside
the chat from 110 terminal columns, so widen the window if the pane does not show.

## Use

| | |
|---|---|
| `/projector <url>` | Downloads, renders and plays the video. |
| `/projector <path>` | Plays a local file. |
| `/projector` | Opens the pane with the URL box. |

In the pane: the bar under the picture toggles play and stop with a click. `p` plays, `s`
stops, `m` switches between inline image and pixel art, `c` picks which browser's cookies to
use, and Escape closes the pane and stops playback.

## YouTube sign-in checks

Some videos refuse anonymous downloads with "sign in to confirm you're not a bot". The Cookies
button, off by default, lets yt-dlp retry with your own browser's YouTube session
(`--cookies-from-browser`). Chrome asks for your login password once through the Keychain;
Safari needs the terminal app to have Full Disk Access. Downloads then count against your
account, so leave it off unless a video needs it.

## How it works

One `ffmpeg` process decodes the video once into 15 fps PNG frames and a small raw RGB stream.
Playback starts after the first second of frames exists and follows the rest as they land.
Frames are pushed into the pane with `$.ui.blit`, so nothing redraws while playing. The cache
under `~/.cache/projector` keeps only the video being played, since frames cost about 100 MB a
minute.

## Limits

- Resolution is bound by the pane: about 100 MB of frames per minute, and in pixel art mode
  two colors per character cell.
- Audio and frames run on separate clocks. Over a long video they can drift by a fraction of a
  second.
- Windows has no `afplay`; install `ffmpeg` to get `ffplay` for sound.
