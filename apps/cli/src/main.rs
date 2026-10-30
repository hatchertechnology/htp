use std::{process::ExitCode, time::Duration};

use clap::Parser;
use htp_shared::MessageResponse;

mod analytics;
mod google_auth;

#[derive(clap::Subcommand)]
enum Command {
    /// Connect Google Analytics and retrieve website reports
    Analytics(analytics::AnalyticsArgs),
}

#[derive(Parser)]
#[command(version, about = "HTP API client and Google Analytics reporting")]
struct Args {
    /// Full URL of the API endpoint
    #[arg(long, global = true, default_value = "http://127.0.0.1:3000/")]
    url: String,
    #[command(subcommand)]
    command: Option<Command>,
}

fn main() -> ExitCode {
    let args = Args::parse();
    if let Some(Command::Analytics(analytics)) = args.command {
        return match analytics::run(analytics, &args.url) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        };
    }
    match fetch_message(&args.url) {
        Ok(response) => {
            println!("{}", response.message);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Failed to fetch API message: {error}");
            ExitCode::FAILURE
        }
    }
}

fn fetch_message(url: &str) -> Result<MessageResponse, reqwest::Error> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?
        .get(url)
        .send()?
        .error_for_status()?
        .json()
}
