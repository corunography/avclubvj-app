const path = require('path');

module.exports = [
  {
    entry: './src/visualizer.js',
    output: {
      filename: 'visualizer.bundle.js',
      path: path.resolve(__dirname, 'dist'),
    },
    target: 'web',
    resolve: { fallback: { fs: false, path: false } },
  },
  {
    entry: './src/controls.js',
    output: {
      filename: 'controls.bundle.js',
      path: path.resolve(__dirname, 'dist'),
    },
    target: 'web',
    resolve: { fallback: { fs: false, path: false } },
  },
];
