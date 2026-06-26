//! Native microphone capture (cpal) and resampling to the engine's 16 kHz mono
//! format (rubato). Compiled only with the `capture` feature.
//!
//! The cpal input callback runs on a real-time OS audio thread, so it does the
//! cheapest possible work: downmix interleaved frames to mono and push them into
//! a lock-free SPSC ring. The speech worker drains the ring on its own thread
//! (computing the live RMS level) and resamples the whole utterance to 16 kHz
//! once, at stop. The cpal `Stream` is `!Send` on CoreAudio, which is why it is
//! owned here and never leaves the worker thread.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer, Split};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// The engine's required input sample rate.
const TARGET_RATE: u32 = 16_000;

/// A live microphone capture. Holds the cpal stream (dropping it stops capture),
/// the ring consumer, and the accumulated device-rate mono samples.
pub(crate) struct Capture {
    // Kept alive for the capture's duration; dropping stops the stream.
    _stream: cpal::Stream,
    consumer: ringbuf::HeapCons<f32>,
    accum: Vec<f32>,
    device_rate: u32,
}

impl Capture {
    /// Open the default input device and start streaming. Returns an error if no
    /// device is available or the OS denies microphone access (the TCC prompt
    /// fires on first attempt); the worker surfaces that to the UI.
    pub(crate) fn start(device_name: Option<&str>) -> Result<Self, String> {
        let host = cpal::default_host();
        // Use the user-chosen input device when named (and still present), else
        // the system default. Falling back keeps capture working if a previously
        // selected device was unplugged.
        let device = device_name
            .and_then(|name| find_input_device(&host, name))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| "no microphone input device found".to_owned())?;
        let supported = device
            .default_input_config()
            .map_err(|err| format!("microphone unavailable: {err}"))?;
        let device_rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        // ~4 seconds of headroom at the device rate; the worker drains every
        // ~40ms so this never fills in practice.
        let capacity = (device_rate as usize * 4).max(64_000);
        let (mut producer, consumer) = HeapRb::<f32>::new(capacity).split();

        let err_fn = |err| eprintln!("[reverie-speech] input stream error: {err}");
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    push_downmixed(data, channels, &mut producer, |s| s);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    push_downmixed(data, channels, &mut producer, |s| s as f32 / 32768.0);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    push_downmixed(data, channels, &mut producer, |s| {
                        (s as f32 - 32768.0) / 32768.0
                    });
                },
                err_fn,
                None,
            ),
            other => return Err(format!("unsupported microphone sample format: {other:?}")),
        }
        .map_err(|err| format!("could not open microphone: {err}"))?;

        stream
            .play()
            .map_err(|err| format!("could not start microphone: {err}"))?;

        Ok(Self {
            _stream: stream,
            consumer,
            accum: Vec::new(),
            device_rate,
        })
    }

    /// Drain everything available from the ring into the accumulator and return
    /// the RMS level (0..1) of the drained chunk for the UI meter.
    pub(crate) fn drain_rms(&mut self) -> f32 {
        let mut buf = [0.0f32; 4096];
        let mut sum_sq = 0.0f64;
        let mut count = 0usize;
        loop {
            let n = self.consumer.pop_slice(&mut buf);
            if n == 0 {
                break;
            }
            for &sample in &buf[..n] {
                sum_sq += f64::from(sample) * f64::from(sample);
            }
            count += n;
            self.accum.extend_from_slice(&buf[..n]);
        }
        if count == 0 {
            0.0
        } else {
            (sum_sq / count as f64).sqrt() as f32
        }
    }

    /// Seconds of audio captured so far.
    pub(crate) fn audio_seconds(&self) -> f32 {
        self.accum.len() as f32 / self.device_rate.max(1) as f32
    }

    /// Stop, drain the tail, and resample the whole utterance to 16 kHz mono.
    pub(crate) fn finish(mut self) -> Result<Vec<f32>, String> {
        self.drain_rms();
        resample_to_target(&self.accum, self.device_rate)
    }
}

/// Downmix interleaved frames to mono and push to the ring. `convert` maps the
/// device sample type to a normalized f32. Runs on the real-time audio thread, so
/// it must not allocate: it converts into a fixed stack buffer and flushes to the
/// ring in chunks (heap allocation here can cause priority inversion and audio
/// dropouts).
fn push_downmixed<S: Copy>(
    data: &[S],
    channels: usize,
    producer: &mut ringbuf::HeapProd<f32>,
    convert: impl Fn(S) -> f32,
) {
    let mut scratch = [0.0f32; 1024];
    let mut filled = 0usize;
    if channels <= 1 {
        for &sample in data {
            scratch[filled] = convert(sample);
            filled += 1;
            if filled == scratch.len() {
                producer.push_slice(&scratch);
                filled = 0;
            }
        }
    } else {
        for frame in data.chunks_exact(channels) {
            let sum: f32 = frame.iter().map(|&s| convert(s)).sum();
            scratch[filled] = sum / channels as f32;
            filled += 1;
            if filled == scratch.len() {
                producer.push_slice(&scratch);
                filled = 0;
            }
        }
    }
    if filled > 0 {
        producer.push_slice(&scratch[..filled]);
    }
}

/// Find an input device by its reported name.
fn find_input_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.input_devices()
        .ok()?
        .find(|device| device.name().map(|n| n == name).unwrap_or(false))
}

/// The names of the available microphone input devices, for the device picker.
pub(crate) fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devices) => devices.filter_map(|device| device.name().ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Resample mono `input` from `in_rate` to 16 kHz. A no-op when already 16 kHz.
/// Feeds the buffer through rubato's fixed-input sinc resampler in chunks,
/// zero-padding the final partial chunk (a few ms of trailing silence, harmless
/// for ASR).
fn resample_to_target(input: &[f32], in_rate: u32) -> Result<Vec<f32>, String> {
    if in_rate == TARGET_RATE || input.is_empty() {
        return Ok(input.to_vec());
    }
    let ratio = f64::from(TARGET_RATE) / f64::from(in_rate);
    let chunk = 1024usize;
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.1, params, chunk, 1)
        .map_err(|err| format!("resampler init failed: {err}"))?;

    let mut out = Vec::with_capacity((input.len() as f64 * ratio) as usize + chunk);
    let mut scratch = vec![vec![0.0f32; chunk]];
    let mut pos = 0;
    while pos < input.len() {
        let end = (pos + chunk).min(input.len());
        let n = end - pos;
        scratch[0][..n].copy_from_slice(&input[pos..end]);
        if n < chunk {
            scratch[0][n..].fill(0.0);
        }
        let resampled = resampler
            .process(&scratch, None)
            .map_err(|err| format!("resample failed: {err}"))?;
        out.extend_from_slice(&resampled[0]);
        pos += chunk;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{TARGET_RATE, resample_to_target};

    #[test]
    fn resample_passthrough_at_target_rate() {
        let input = vec![0.25f32; 8_000];
        let out = resample_to_target(&input, TARGET_RATE).unwrap();
        assert_eq!(out.len(), input.len());
    }

    #[test]
    fn resample_downsamples_48k_to_16k_by_a_third() {
        // 48 kHz -> 16 kHz is 3:1, so 48_000 input frames (1s) yield ~16_000.
        let input = vec![0.0f32; 48_000];
        let out = resample_to_target(&input, 48_000).unwrap();
        let expected = 16_000i64;
        let drift = (out.len() as i64 - expected).abs();
        // Allow a small edge effect from the sinc filter / final padded chunk.
        assert!(drift < 1_024, "got {} samples, expected ~{}", out.len(), expected);
    }
}
