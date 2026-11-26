# Rift Bastion sound effects review

Paul approved the 28 sound effects from P4-T4 in chat on November 20, 2026. The approval applies to
the selected takes and masters in the review catalog with SHA-256
`e8ef8aea8a0b3840da3ef23d9967fb23c964e6255c120f3753b03f81a56718f6`. The catalog preserves
the original generation-time state. P4-T5 owns integration, the in-game mix, and the eight
owner-supplied Suno WAVs.

## Listen

In a checkout with the private audio restored, build the review and serve it on loopback. Use the
booked preview port if 4273 is occupied.

```sh
bun --bun vite build --mode audition
bun --bun vite preview --mode audition --host 127.0.0.1 --port 4273 --strictPort
```

Open `http://127.0.0.1:4273/audition.html`. Each row has an original MP3 and a mastered player with
Opus and MP3 options. Starting any clip pauses the previous player. The rift ambience has a repeat
control for comparison across several wraps. Its louder original is included for comparison.
For Quest, the owner can open the same URL in Quest Browser using the USB-reversed preview port.

The optimized review bundle lives in `.local/rift-sfx/audition-dist`. The Pages workflow excludes the private audition
bundle and source archive. Keep isolated clips out of public repositories, static hosting, and
standalone downloads. The normal game dev
server denies the SFX archive, audition entry and assets, and private build directory.

The game bundles the 28 approved recordings inside its executable audio module. It decodes the
recordings through Web Audio with Opus and MP3 support. Synthesis is the fallback if both decoders
fail. GitHub Actions can build from a clean checkout because the executable module is checked in.

With the approved staging files restored, regenerate the module with
`bun scripts/assets/pack-game-sfx.ts --pack`. The packer checks the catalog approval hash and each
source derivative before embedding it. The build checks both embedded formats against the catalog
without needing the private archive.

## Inspect or rebuild

`contract.json` records the four cue families, gameplay triggers, exact prompts, processing
decisions, and delivery limits. Each `raw/<cue>/take-##/` has the request, HTTP receipt and original
provider response. All 28 first takes and the rift-loop retry are preserved. ElevenLabs returned
the `character-cost` header for each response without a generation, request, or history ID in the
generation metadata. Its [history API](https://elevenlabs.io/docs/api-reference/history/list)
excludes sound effects.

The JSON receipts and `staging/catalog.json` are tracked. Restore `response.mp3` into each original
take directory from the private archive before rebuilding. The mastered audio under `staging/` is
generated locally, and the provider's original response bytes stay untouched.

```sh
python3 scripts/assets/sfx.py build
python3 scripts/assets/sfx.py verify
python3 scripts/assets/sfx.py reproduce
```

Use the FFmpeg build identified in the catalog for byte-for-byte reproduction. The offline build
uses Python's standard library, FFmpeg, FFprobe, libopus, and libmp3lame. It folds stereo with
`0.5L + 0.5R` for single-point spatial emitters, removes sub-bass below 65 Hz, trims and pads
one-shots, and builds a 160 ms equal-power wrap for the rift ambience. Linear gain targets the
cue-family loudness with true-peak headroom, verified after both encodes. The mono 24-bit FLAC
masters and the mono 48 kHz Opus and MP3 encodes retain the exact decoded sample count, and the MP3
keeps its Lavc/Xing gapless metadata. Integrated LUFS for short clips uses a silence-padded
EBU R128 analysis window. The validator probes and fully decodes the files, recomputes hashes,
inspects both codecs' loudness and peak, checks silence and loop boundaries, and rejects positive
clipping, silence, wrong-hash, and stereo cancellation controls. The catalog records the selected
source, master edits, hashes, and measured derivative metadata per cue.

Use `--directory` with `build` to stage a new candidate elsewhere. A build refuses to overwrite any
differing staged file.

## Billing and rights

The paid Starter account had overage disabled and $0 overage. The account meter settled at 8,738
of 68,736 included credits after 29 successful calls. This used 538 credits, matching the sum of the
response headers. The run used 458 for the first 28 takes and 80 for one alternate rift loop.
See `usage.json` for the reconciliation. Generating and retrying through
`scripts/assets/generate-sfx.py` consumes included ElevenLabs credits. Routine offline rebuilding
and validation use the archived sources.

The embedded recordings are distributed for use in Rift Bastion under the ElevenLabs Sound Effects
terms. Paid-plan terms allow commercial game incorporation subject to the applicable terms and
prohibited-use policy. ElevenCreative's Sound Effects Exhibit 4 restricts distributing or making
available isolated clips. Archive and audition access are private. See the
[paid-plan billing documentation](https://elevenlabs.io/docs/overview/administration/billing),
[ElevenAPI terms](https://elevenlabs.io/elevenapi-terms),
[ElevenCreative Sound Effects terms](https://elevenlabs.io/creative-terms), and
[ElevenLabs Terms of Service](https://elevenlabs.io/terms-of-use).

This batch is pinned to `eleven_text_to_sound_v2`. ElevenLabs lists March 1, 2027 as its removal
date. Any future model migration requires a new generation and asset qualification decision.
[ElevenLabs sound effects documentation](https://elevenlabs.io/docs/overview/capabilities/sound-effects).
