import ChatImage from './ChatImage';

export default function ToolImageResult({ images }: { images: string[] }) {
  return <section className="tool-image-result" aria-label={`已查看 ${images.length} 张图像`}>
    <div className="tool-image-thumbnails">{images.map((source, index) => <ChatImage key={source} source={source} alt={`已查看的图像 ${index + 1}`} className="tool-image-thumbnail" />)}</div>
  </section>;
}
