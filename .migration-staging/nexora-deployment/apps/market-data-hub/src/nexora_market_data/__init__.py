"""NEXORA market-data-hub MVP package.

Read-only daily FX reference rates. No trading, custody, or account features.
"""

__version__ = "0.1.0"

DISCLAIMER = (
    "Daily reference rate — not a live executable quote and not trading advice."
)

DATA_STATUS = "DAILY_REFERENCE"
PRICE_TYPE = "MID"
EXECUTABLE = False

NORMALIZATION_VERSION = "nexora-normalizer/1"
OBSERVATION_SCHEMA_VERSION = "nexora-fx-observation/1"
