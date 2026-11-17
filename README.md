# Transkribera

Gör om föreläsningar (även flera timmar långa videor på flera GB) till text på svenska – direkt i webbläsaren.

**Öppna:** https://thekinghim.github.io/transkribera/

- Taligenkänning med [KB-Whisper](https://huggingface.co/KBLab) (base = Snabb, small = Noggrann) via transformers.js, i en Web Worker (WebGPU, annars WASM).
- Videon laddas aldrig upp. Ljudet läses ur MP4-filen bit för bit (mp4box + WebCodecs), ca 5 minuter åt gången.
- Sparas löpande i IndexedDB – stäng fliken och fortsätt senare.
- Klicka på en mening för att spela upp, sök, stjärnmärk, anteckningar, läsläge, automatiska avsnitt, nyckelbegrepp, förhör.
- Export: Word, TXT, Markdown, SRT. AI-pluggknappar som kopierar prompt + text och öppnar claude.ai.

Fungerar bäst i Chrome eller Edge på dator.
