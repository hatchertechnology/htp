#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = htp_api::app();
    let address = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;

    println!("Listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app).await
}
