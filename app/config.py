from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    app_mode: str = "demo"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    database_url: str = "sqlite:///data/processed/election_newsroom.db"

    openai_api_key: str = ""
    openai_chat_model: str = "gpt-4.1-mini"
    openai_embedding_model: str = "text-embedding-3-small"

    election_data_provider: str = "data_go_kr"
    election_data_api_url: str = "https://apis.data.go.kr/9760000/VoteXmntckInfoInqireService2"
    election_data_api_key: str = ""
    election_stream_mode: str = "mock"
    websocket_refresh_seconds: float = 2.0

    google_fact_check_enabled: bool = False
    google_fact_check_api_key: str = ""
    google_fact_check_api_url: str = "https://factchecktools.googleapis.com/v1alpha1/claims:search"

    elasticsearch_enabled: bool = False
    elasticsearch_url: str = ""
    elasticsearch_username: str = ""
    elasticsearch_password: str = ""
    elasticsearch_api_key: str = ""

    cms_enabled: bool = False
    cms_api_url: str = ""
    cms_api_token: str = ""

    kafka_enabled: bool = False
    kafka_bootstrap_servers: str = ""
    kafka_topic: str = "election-results"

    @property
    def db_path(self) -> Path:
        raw = self.database_url.removeprefix("sqlite:///")
        path = Path(raw)
        return path if path.is_absolute() else ROOT / path


@lru_cache
def get_settings() -> Settings:
    return Settings()

