export default function QuickReplyButtons({ replies, onSelect }) {
  return (
    <div className="px-4 py-2 flex flex-wrap gap-2">
      {replies.map((reply, i) => (
        <button
          key={i}
          onClick={() => onSelect(reply.value)}
          className="border border-cushion-500 text-cushion-700 rounded-full px-4 py-1.5 text-sm hover:bg-cushion-50 transition-colors"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
