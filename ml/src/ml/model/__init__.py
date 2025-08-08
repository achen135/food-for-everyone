"""Model A — will this open listing expire unclaimed?

`dataset` builds the design matrix and divides `val`; `search` picks
hyperparameters; `calibrate` turns the booster's output into a probability and
places the operating points; `explain` attributes predictions; `artifact`
loads and saves the committed bundle; `card` writes it all down.

The entry point is `python -m ml.model` (`make model`).
"""
