fn main() {
    // Lets tests find the sidecar built for this target (`binaries/stockfish-<triple>`).
    let target = std::env::var("TARGET").expect("cargo sets TARGET for build scripts");
    println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    tauri_build::build()
}
