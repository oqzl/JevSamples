# JRA historical backtest

This experiment tests TypeSafe Jev against the historical JRA dataset published on Kaggle:

- Dataset: `takamotoki/jra-horse-racing-dataset`
- The dataset itself is not committed or redistributed here.
- Start with `19860105-20210731_race_result.csv`.

The default benchmark is deliberately strict:

1. Real horse, jockey, trainer, and race names are hidden from Jev.
2. Current-race odds and popularity are hidden from Jev.
3. Current-race finish, time, margins, and other post-race facts are never placed in model state.
4. Historical features are computed only from races with a date before the target race.
5. The raw Jev response is cached, so reporting can be rerun without paying for inference again.
6. Only races whose runner rows all have numeric finish positions are used in the first version.

The anonymization matters because historical races may exist in a pretrained model's world knowledge. A historical benchmark with recognizable identities can silently become a memorization test.

## 1. Download the Kaggle data

Using the Kaggle CLI:

```sh
python -m pip install kaggle
mkdir -p data/jra
kaggle datasets download -d takamotoki/jra-horse-racing-dataset -p data/jra --unzip
```

Expected file:

```text
data/jra/19860105-20210731_race_result.csv
```

## 2. Inspect headers

The dataset has had variants in column naming, so inspect before importing:

```sh
python backtest/jra/jra_backtest.py inspect data/jra/19860105-20210731_race_result.csv
```

## 3. Build the local SQLite index

```sh
python backtest/jra/jra_backtest.py build \
  data/jra/19860105-20210731_race_result.csv \
  --db data/jra/jra.sqlite3 --reset
```

This streams the CSV; it does not load the whole dataset into RAM.

## 4. Inspect exactly what Jev would see

No API call:

```sh
python backtest/jra/jra_backtest.py run \
  --db data/jra/jra.sqlite3 \
  --from 2021-01-01 --limit 1 --dry-run
```

Check this output when adding features. Outcome leakage belongs here, not after a large paid run.

## 5. Run a small blind backtest

```sh
export TYPESAFE_API_KEY=...
python backtest/jra/jra_backtest.py run \
  --db data/jra/jra.sqlite3 \
  --from 2021-01-01 --to 2021-07-31 --limit 20
```

For each race, one System One call asks:

- one Choice across the runners for the winner distribution;
- one Noul per runner for top-three likelihood.

## 6. Report

```sh
python backtest/jra/jra_backtest.py report --db data/jra/jra.sqlite3
```

The report includes top-1 accuracy, multiclass log loss/Brier score, flat win ROI where odds exist, and a first-favorite baseline.

## Controlled experiments

Expose current market odds/popularity:

```sh
python backtest/jra/jra_backtest.py run --db data/jra/jra.sqlite3 --market odds --limit 20
python backtest/jra/jra_backtest.py report --db data/jra/jra.sqlite3 --market odds
```

Expose real identities deliberately:

```sh
python backtest/jra/jra_backtest.py run --db data/jra/jra.sqlite3 --identities --limit 20
```

Do not mix those results with the default blind benchmark. They answer different questions.
