use std::fs;
use std::path::PathBuf;

fn main() {
    ensure_default_icon();
    tauri_build::build();
}

fn ensure_default_icon() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icons_dir = manifest_dir.join("icons");
    let icon_path = icons_dir.join("icon.png");

    fs::create_dir_all(&icons_dir).expect("create Tauri icons directory");
    fs::write(icon_path, one_px_rgba_png()).expect("write default Tauri icon");
}

fn one_px_rgba_png() -> Vec<u8> {
    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let ihdr = [
        0, 0, 0, 1, // width
        0, 0, 0, 1, // height
        8, // bit depth
        6, // RGBA
        0, // compression
        0, // filter
        0, // interlace
    ];
    push_chunk(&mut png, b"IHDR", &ihdr);

    let scanline = [0, 31, 37, 49, 255]; // filter byte + one opaque Reverie-dark RGBA pixel
    let mut zlib = vec![0x78, 0x01, 0x01, 5, 0, 0xfa, 0xff]; // zlib + final uncompressed DEFLATE block
    zlib.extend_from_slice(&scanline);
    zlib.extend_from_slice(&adler32(&scanline).to_be_bytes());
    push_chunk(&mut png, b"IDAT", &zlib);
    push_chunk(&mut png, b"IEND", &[]);
    png
}

fn push_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);

    let mut crc_input = Vec::with_capacity(kind.len() + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let mut a = 1_u32;
    let mut b = 0_u32;
    for byte in bytes {
        a = (a + *byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}
