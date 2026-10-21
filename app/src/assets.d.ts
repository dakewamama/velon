// Bun's bundler turns an imported image into the URL it serves it from.
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.svg" {
  const url: string;
  export default url;
}
