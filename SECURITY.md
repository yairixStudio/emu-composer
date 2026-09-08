# Security

emu-composer runs locally and binds to `127.0.0.1` only. It talks to the emulator through
`adb` and, when installed, to an on-device agent through an adb port forward.

- The OpenAI key for dictation is stored at `~/.config/emu-composer/openai-key` (mode 600)
  and is used server-side only; the page never receives it back.
- `setup-agent` is the only step that downloads anything (uiautomator2 from PyPI, into a
  venv that is not used at runtime). The server never downloads on its own.
- Unicode typing goes through the device clipboard, which is overwritten by every paste.

Report a vulnerability by opening a private security advisory on GitHub, or an issue if it
is not sensitive.
