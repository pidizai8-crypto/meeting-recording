# Bundled speech models

The meeting plugin loads both models from this directory. Inference runs in a private local process using the host installation's `sherpa-onnx-node` CPU runtime. Models and audio stay on the host.

## CAM++ Chinese and English speaker embedding

`campplus-zh-en-fp16.onnx` contains the 192-dimensional CAM++ model from Alibaba DAMO Academy / 3D-Speaker. ModelScope publishes `iic/speech_campplus_sv_zh_en_16k-common_advanced` v1.0.0 under Apache License 2.0. The k2-fsa project exported the ONNX model. Luigi's distribution converted that export to FP16 with the statistics subgraph retained in FP32. This plugin redistributes the resulting FP16 file unchanged. The full license is in [LICENSE-CAMPLUS.txt](./LICENSE-CAMPLUS.txt).

- [Original model and license](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced)
- [3D-Speaker project](https://github.com/modelscope/3D-Speaker)
- [Sherpa ONNX export](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)
- [FP16 model card and pinned revision](https://huggingface.co/Luigi/campplus-zh-en-onnx/tree/aa79cf9b8628a46ca362bf9bf7cde226a470a282)
- SHA-256 `62eb2d79d363c1fd5ee093a4b0dcb5470d5ad3b7452612b67cce9b89f36c8ef3`, 14,695,579 bytes.

## Silero voice activity detection

`silero-vad.onnx` is the unchanged Silero VAD v5.1.2 model, copyright (c) 2020-present Silero Team, distributed under the [MIT license](./LICENSE-SILERO.txt). It selects the speech frames used by the embedding model.

- [Model and original license at v5.1.2](https://github.com/snakers4/silero-vad/tree/6478567951ae5c9979ad7b234185b5515f4be7a1)
- SHA-256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`, 2,327,524 bytes.
