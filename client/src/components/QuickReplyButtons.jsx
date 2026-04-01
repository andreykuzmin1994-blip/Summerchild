export default function QuickReplyButtons({ replies, onSelect }) {
  return (
    <div className="px-3 sm:px-4 py-2 flex flex-wrap gap-2" role="group" aria-label="Quick reply options">
      {replies.map((reply, i) => (
        <button
          key={i}
          onClick={() => onSelect(reply.value)}
          className="border border-cushion-500 text-cushion-700 rounded-full px-3 sm:px-4 py-3 text-sm hover:bg-cushion-50 transition-colors focus:outline-none focus:ring-2 focus:ring-cushion-500 focus:ring-offset-2"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
