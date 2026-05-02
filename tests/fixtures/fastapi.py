from fastapi import FastAPI
from sqlalchemy import create_engine
import alembic.config

app = FastAPI()
engine = create_engine("sqlite:///./test.db")


@app.route("/users")
def list_users():
    return {"users": []}


@app.route("/health")
def health():
    return {"ok": True}
