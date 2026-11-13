const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// Output goes to dist/, which is what gets deployed as the static site (the IT-owned SWA config serves it).
module.exports = {
  entry: { taskpane: './src/taskpane/taskpane.ts' },
  output: { filename: '[name].js', path: `${__dirname}/dist`, clean: true },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }] },
  devtool: false,
  plugins: [
    new HtmlWebpackPlugin({ filename: 'taskpane.html', template: './src/taskpane/taskpane.html', chunks: ['taskpane'] }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/taskpane/signin-complete.html', to: 'signin-complete.html' },
        { from: 'assets', to: 'assets' },
        { from: 'manifest.xml', to: 'manifest.xml' },
      ],
    }),
  ],
};
