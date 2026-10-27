# --- whisper.cpp: rozpoznání jazyka řeči (ověření, že "eng" stopa opravdu není česká) ---
FROM alpine:3.24 AS whisper
# vulkan-headers, vulkan-loader-dev, shaderc (glslc) a spirv-headers: sestavení whisper.cpp pro grafickou kartu
RUN apk add --no-cache build-base cmake git curl vulkan-headers vulkan-loader-dev shaderc spirv-headers
ARG WHISPER_VERSION=v1.9.4
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /src
# Dvě binárky: pro procesor a s Vulkanem (GPU). Když GPU selže nebo chybí, počítá ta první.
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli \
 && strip /build/bin/whisper-cli
RUN cmake -S /src -B /build-vk -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF -DGGML_VULKAN=ON \
 && cmake --build /build-vk -j"$(nproc)" --target whisper-cli \
 && strip /build-vk/bin/whisper-cli
# Vícejazyčné modely "base" a přesnější "small" (hlavně pro GPU) v kvantizaci q8_0 – přesnost prakticky
# stejná jako plné modely, ale 82 MB a 264 MB místo 148 MB a 488 MB. Ukládají se pod původními názvy.
# Dále Silero VAD (pozná úseky s řečí) a krátká anglická nahrávka pro ověření grafické karty.
RUN mkdir /models \
 && curl -fL --retry 3 -o /models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin \
 && curl -fL --retry 3 -o /models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin \
 && curl -fL --retry 3 -o /models/ggml-silero.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin \
 && cp /src/samples/jfk.wav /models/jfk.wav

# --- ffmpeg/ffprobe: jen to, co aplikace potřebuje ---
# Balík ffmpeg z Alpine táhne desítky knihoven (x264/x265, AV1 enkodéry, VA-API, X11, PulseAudio…) za ~150 MB.
# Tady se staticky sestaví bez externích knihoven: všechny vestavěné demuxery, parsery a dekodéry
# (ffprobe i dekódování zvuku), z výstupů PCM do WAV a do roury a přepočet tempa zvuku donoru s jinou
# rychlostí (PAL 25 vs 23,976 fps): filtry atempo/asetrate, vestavěné enkodéry E-AC-3/AC-3/AAC, výstup do MKA.
# Čtení jen ze souborů a rour.
FROM alpine:3.24 AS ffmpeg
RUN apk add --no-cache build-base nasm curl xz zlib-dev zlib-static
ARG FFMPEG_VERSION=8.1.3
RUN curl -fL --retry 3 https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz | tar -xJ -C / \
 && cd /ffmpeg-${FFMPEG_VERSION} \
 && ./configure --prefix=/opt/ffmpeg --enable-static --disable-shared --extra-ldflags=-static \
      --disable-autodetect --enable-zlib --disable-debug --disable-doc --disable-ffplay \
      --disable-network --disable-devices --disable-hwaccels \
      --disable-encoders --enable-encoder=pcm_s16le,eac3,ac3,aac \
      --disable-muxers --enable-muxer=wav,pcm_s16le,matroska \
      --disable-protocols --enable-protocol=file,pipe \
      --disable-filters --enable-filter=aresample,aformat,anull,atrim,null,trim,format,scale,atempo,asetrate \
 && make -j"$(nproc)" && make install && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe \
 && rm -rf /ffmpeg-${FFMPEG_VERSION}
# Kontrola: převod na 16 kHz mono WAV (jako pro Whisper), PCM do roury (jako kontrola synchronizace)
# a přepočet tempa do MKA (jako u donoru s 25 fps)
COPY --from=whisper /models/jfk.wav /tmp/jfk.wav
RUN /opt/ffmpeg/bin/ffmpeg -v error -y -ss 1 -t 5 -i /tmp/jfk.wav -map 0:0 -ac 1 -ar 16000 -c:a pcm_s16le /tmp/out.wav \
 && /opt/ffmpeg/bin/ffmpeg -v error -i /tmp/jfk.wav -map 0:0 -ac 1 -ar 8000 -f s16le pipe:1 > /dev/null \
 && /opt/ffmpeg/bin/ffprobe -v error -print_format json -show_streams -show_format /tmp/out.wav > /dev/null \
 && /opt/ffmpeg/bin/ffmpeg -v error -y -i /tmp/jfk.wav -map 0:0 -af atempo=0.95904 -ac 2 -ar 48000 -c:a eac3 -b:a 192k -metadata:s:a:0 language=cze -f matroska /tmp/t1.mka \
 && /opt/ffmpeg/bin/ffmpeg -v error -y -i /tmp/jfk.wav -map 0:0 -af asetrate=15344.6,aresample=16000 -c:a aac -b:a 128k -f matroska /tmp/t2.mka \
 && /opt/ffmpeg/bin/ffprobe -v error -show_streams /tmp/t1.mka | grep -q codec_name=eac3 \
 && rm /tmp/*.wav /tmp/*.mka

# --- aplikace ---
# Čisté Alpine s Node.js z balíků místo oficiálního node image (ten má Node se vším všudy, npm a yarn)
FROM alpine:3.24
# MESA_SHADER_CACHE_DIR: zkompilované shadery pro GPU přežijí i nový kontejner (jinak se připravují znovu)
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 MESA_SHADER_CACHE_DIR=/data/cache/mesa
# nodejs + icu-data-full: čeština v toLocaleDateString('cs-CZ'), mkvtoolnix: slučování stop do jednoho MKV,
# libgomp: vlákna pro whisper.cpp, vulkan-loader + mesa-vulkan-ati: Vulkan ovladač pro grafické karty AMD.
# Z balíku mesa (závislost Vulkan ovladače) se maže knihovna Gallium pro OpenGL/GBM – Vulkan ji nepoužívá.
RUN apk add --no-cache nodejs icu-data-full mkvtoolnix libgomp vulkan-loader mesa-vulkan-ati \
 && rm -f /usr/lib/libgallium-*.so /usr/lib/gbm/dri_gbm.so \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /build-vk/bin/whisper-cli /usr/local/bin/whisper-cli-vulkan
COPY --from=whisper /models /models
WORKDIR /app
# Žádné npm závislosti – jen Node.js
COPY package.json ./
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server.js"]
