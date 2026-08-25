/**
 * Reusable pagination helper for Mongoose queries.
 *
 * @param {Object}  model        – Mongoose model (e.g. Student, Teacher)
 * @param {Object}  query        – filter conditions (default {})
 * @param {Object}  options
 * @param {number}  options.page – 1-based page number (default 1)
 * @param {number}  options.limit – items per page (default 20, max 100)
 * @param {string}  options.sort – sort string e.g. "-createdAt" (default "-createdAt")
 * @param {string}  options.select – fields to select (default "")
 * @param {Array}   options.populate – populate config(s)
 * @returns {Object} { data, pagination }
 */
exports.paginate = async (model, query = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
  const skip = (page - 1) * limit;
  const sort = options.sort || "-createdAt";

  let chain = model.find(query).skip(skip).limit(limit).sort(sort);

  if (options.select) chain = chain.select(options.select);
  if (options.populate) {
    const pops = Array.isArray(options.populate) ? options.populate : [options.populate];
    for (const p of pops) {
      chain = chain.populate(p);
    }
  }

  const [data, total] = await Promise.all([
    chain.lean(),
    model.countDocuments(query),
  ]);

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasPrev: page > 1,
      hasNext: page < Math.ceil(total / limit),
    },
  };
};
