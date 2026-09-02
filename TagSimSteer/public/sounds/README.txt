Drop your own driver sound-effect recordings in here using these exact filenames
(referenced directly by tag-steering-simulator.jsx as /sounds/<name>):

  horn.mp3               - plays on loop while the horn (Space) is held, stops on release
  handbrake-on.mp3       - one-shot, plays ~2s after the bus comes to rest
  handbrake-release.mp3  - one-shot, plays when pulling away again after the handbrake set

MP3 is recommended (small, universally supported for short clips), but any format the
browser can play works. Until real files are placed here, these are silent no-ops - a
missing file just makes playback fail quietly, it won't break the app.
